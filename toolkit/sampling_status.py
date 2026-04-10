from typing import Any, Optional, Sequence


def get_sampling_media_noun(config: Optional[Any]) -> str:
    num_frames = getattr(config, "num_frames", 1)
    return "videos" if num_frames > 1 else "images"


def get_sampling_progress_message(
    config: Optional[Any],
    current: Optional[int] = None,
    total: Optional[int] = None,
) -> str:
    noun = get_sampling_media_noun(config)
    if current is None or total is None:
        return f"Generating {noun}"
    return f"Generating {noun} - {current}/{total}"


def get_sampling_progress_desc(config: Optional[Any]) -> str:
    return get_sampling_progress_message(config).title()


def get_sampling_status_config(
    configs: Optional[Sequence[Any]],
    sample_index: int = 0,
) -> Optional[Any]:
    if configs is None or len(configs) == 0:
        return None
    bounded_index = min(max(sample_index, 0), len(configs) - 1)
    return configs[bounded_index]


def get_initial_sampling_progress_desc(configs: Optional[Sequence[Any]]) -> str:
    return get_sampling_progress_desc(get_sampling_status_config(configs, sample_index=0))


def update_sampling_progress_desc(progress_bar: Any, config: Optional[Any]) -> None:
    progress_bar.set_description_str(get_sampling_progress_desc(config))
