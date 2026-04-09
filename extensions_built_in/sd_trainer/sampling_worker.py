import copy
import gc
import json
import os
import signal
import time
from typing import Optional

from toolkit.config_modules import GenerateImageConfig, ModelConfig, SampleConfig
from toolkit.print import print_acc
from toolkit.sampler import get_sampler
from toolkit.util.get_model import get_model_class
from toolkit.basic import flush

from extensions_built_in.sd_trainer.aitk_db import (
    claim_next_sample_task,
    complete_sample_task,
    count_open_sample_tasks,
    fail_sample_task,
    get_attempt_state,
    get_job_flags,
    reset_running_sample_tasks,
    update_attempt,
    update_job,
)


class SamplingWorker:
    def __init__(self, sqlite_db_path: str, job_id: str, attempt_id: str):
        self.sqlite_db_path = sqlite_db_path
        self.job_id = job_id
        self.attempt_id = attempt_id
        self.should_exit = False
        self.sd = None
        self.current_signature = None

    def handle_signal(self, signum, frame):
        self.should_exit = True

    def _is_pid_alive(self, pid: Optional[int]):
        if pid is None:
            return False
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    def _build_noise_scheduler(self, process_config: dict, model_config: ModelConfig):
        train_config = process_config.get("train", {})
        noise_scheduler_name = train_config.get("noise_scheduler", "ddpm")
        arch = 'sd'
        if model_config.is_pixart:
            arch = 'pixart'
        if model_config.is_flux:
            arch = 'flux'
        if model_config.is_lumina2:
            arch = 'lumina2'

        return get_sampler(
            noise_scheduler_name,
            {
                "prediction_type": "v_prediction" if model_config.is_v_pred else "epsilon",
            },
            arch=arch,
        )

    def _ensure_model_loaded(self, task_config: dict, artifact_path: Optional[str]):
        process_config = copy.deepcopy(task_config["process_config"])
        model_config_raw = copy.deepcopy(process_config.get("model", {}))
        model_config_raw["dtype"] = process_config.get("train", {}).get("dtype", model_config_raw.get("dtype", "float16"))
        model_config_raw["lora_path"] = artifact_path

        signature = json.dumps(
            {
                "model": model_config_raw,
            },
            sort_keys=True,
        )
        if self.sd is not None and self.current_signature == signature:
            return

        self._cleanup_model()

        model_config = ModelConfig(**model_config_raw)
        ModelClass = get_model_class(model_config)
        noise_scheduler = self._build_noise_scheduler(process_config, model_config)

        self.sd = ModelClass(
            device="cuda:0" if os.environ.get("CUDA_VISIBLE_DEVICES") != "mps" else "mps",
            model_config=model_config,
            dtype=process_config.get("train", {}).get("dtype", "bf16"),
            noise_scheduler=noise_scheduler,
        )
        self.sd.load_model()
        self.current_signature = signature

    def _build_image_configs(self, task_config: dict):
        sample_config = SampleConfig(**task_config["sample_config"])
        sample_folder = os.path.join(task_config["save_root"], "samples")
        os.makedirs(sample_folder, exist_ok=True)

        start_seed = sample_config.seed
        current_seed = start_seed
        image_configs = []

        for index in range(len(sample_config.prompts)):
            if sample_config.walk_seed:
                current_seed = start_seed + index

            sample_item = sample_config.samples[index]
            if sample_item.seed is not None:
                current_seed = sample_item.seed

            step_num = f"_{str(task_config['step']).zfill(9)}"
            output_path = os.path.join(sample_folder, f"[time]_{step_num}_[count].{sample_config.ext}")
            prompt = sample_config.prompts[index]

            if task_config.get("trigger_word"):
                prompt = self.sd.inject_trigger_into_prompt(
                    prompt,
                    task_config["trigger_word"],
                    add_if_not_present=False,
                )

            image_configs.append(
                GenerateImageConfig(
                    prompt=prompt,
                    width=sample_item.width,
                    height=sample_item.height,
                    negative_prompt=sample_item.neg,
                    seed=current_seed,
                    guidance_scale=sample_item.guidance_scale,
                    guidance_rescale=sample_config.guidance_rescale,
                    num_inference_steps=sample_item.sample_steps,
                    network_multiplier=sample_item.network_multiplier,
                    output_path=output_path,
                    output_ext=sample_config.ext,
                    adapter_conditioning_scale=sample_config.adapter_conditioning_scale,
                    refiner_start_at=sample_config.refiner_start_at,
                    extra_values=sample_config.extra_values,
                    num_frames=sample_item.num_frames,
                    fps=sample_item.fps,
                    ctrl_img=sample_item.ctrl_img,
                    ctrl_idx=sample_item.ctrl_idx,
                    ctrl_img_1=sample_item.ctrl_img_1,
                    ctrl_img_2=sample_item.ctrl_img_2,
                    ctrl_img_3=sample_item.ctrl_img_3,
                    do_cfg_norm=sample_config.do_cfg_norm,
                )
            )

        return sample_config, image_configs

    def _cleanup_model(self):
        if self.sd is not None:
            try:
                del self.sd
            except Exception:
                pass
            self.sd = None
            self.current_signature = None
            gc.collect()
            flush()

    def _process_task(self, task: dict):
        task_config = json.loads(task["frozen_config"])
        artifact_path = task.get("artifact_path")
        self._ensure_model_loaded(task_config, artifact_path)

        sample_config, image_configs = self._build_image_configs(task_config)
        update_job(
            self.sqlite_db_path,
            self.job_id,
            info=f"Sampling step {task['step']}",
        )
        self.sd.generate_images(image_configs, sampler=sample_config.sampler)

        if task.get("cleanup_on_complete") and artifact_path and os.path.exists(artifact_path):
            try:
                os.remove(artifact_path)
            except OSError:
                pass

    def run(self):
        signal.signal(signal.SIGINT, self.handle_signal)
        signal.signal(signal.SIGTERM, self.handle_signal)
        reset_running_sample_tasks(self.sqlite_db_path, self.attempt_id, "Sampler restarted")

        while not self.should_exit:
            update_attempt(
                self.sqlite_db_path,
                self.attempt_id,
                heartbeat_at=time.strftime("%Y-%m-%d %H:%M:%S"),
            )

            job_flags = get_job_flags(self.sqlite_db_path, self.job_id)
            attempt_state = get_attempt_state(self.sqlite_db_path, self.attempt_id)
            open_tasks = count_open_sample_tasks(self.sqlite_db_path, self.attempt_id)

            trainer_alive = self._is_pid_alive(attempt_state.get("trainer_pid") if attempt_state else None)
            if job_flags is None or attempt_state is None:
                break

            if job_flags["stop"] or job_flags["return_to_queue"]:
                break

            if not trainer_alive and open_tasks == 0 and job_flags["status"] in ["running", "starting", "stopping", "error"]:
                break

            task = claim_next_sample_task(self.sqlite_db_path, self.attempt_id)
            if task is None:
                if open_tasks == 0 and job_flags["status"] in ["completed", "stopped", "queued", "error"]:
                    break
                time.sleep(2.0)
                continue

            try:
                self._process_task(task)
                complete_sample_task(self.sqlite_db_path, task["id"])
            except Exception as error:
                print_acc(f"Sampling task failed: {error}")
                fail_sample_task(self.sqlite_db_path, task["id"], str(error))
                artifact_path = task.get("artifact_path")
                if task.get("cleanup_on_complete") and artifact_path and os.path.exists(artifact_path):
                    try:
                        os.remove(artifact_path)
                    except OSError:
                        pass
                update_job(
                    self.sqlite_db_path,
                    self.job_id,
                    info=f"Sampling failed at step {task['step']}",
                )

        self._cleanup_model()
