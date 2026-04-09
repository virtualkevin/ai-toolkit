import prisma from '../prisma';
import { Job } from '@prisma/client';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { TOOLKIT_ROOT, getTrainingFolder, getHFToken } from '../paths';
import { claimRunAttempt, finalizeAttempt, updateAttemptHeartbeat } from './attempts';
import { resolveGpuAssignment } from '../../lib/jobGpu';
import { getSamplingWorkerSupport } from '../../lib/samplingSupport';

const isWindows = process.platform === 'win32';

const rotateLogFile = (trainingFolder: string, logPath: string) => {
  try {
    if (!fs.existsSync(logPath)) return;

    const logsFolder = path.join(trainingFolder, 'logs');
    if (!fs.existsSync(logsFolder)) {
      fs.mkdirSync(logsFolder, { recursive: true });
    }

    let num = 0;
    while (fs.existsSync(path.join(logsFolder, `${num}_log.txt`))) {
      num++;
    }

    fs.renameSync(logPath, path.join(logsFolder, `${num}_log.txt`));
  } catch (error) {
    console.error('Error rotating log file:', error);
  }
};

const getPythonPath = () => {
  let pythonPath = 'python';
  if (fs.existsSync(path.join(TOOLKIT_ROOT, '.venv'))) {
    pythonPath = isWindows
      ? path.join(TOOLKIT_ROOT, '.venv', 'Scripts', 'python.exe')
      : path.join(TOOLKIT_ROOT, '.venv', 'bin', 'python');
  } else if (fs.existsSync(path.join(TOOLKIT_ROOT, 'venv'))) {
    pythonPath = isWindows
      ? path.join(TOOLKIT_ROOT, 'venv', 'Scripts', 'python.exe')
      : path.join(TOOLKIT_ROOT, 'venv', 'bin', 'python');
  }
  return pythonPath;
};

const spawnDetachedProcess = (pythonPath: string, args: string[], env: NodeJS.ProcessEnv) => {
  if (isWindows) {
    return spawn(pythonPath, args, {
      env,
      cwd: TOOLKIT_ROOT,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
  }

  return spawn(pythonPath, args, {
    env,
    cwd: TOOLKIT_ROOT,
    detached: true,
    stdio: 'ignore',
  });
};

const maybeWritePidFile = (trainingFolder: string, name: string, pid: number | null) => {
  try {
    fs.writeFileSync(path.join(trainingFolder, name), String(pid ?? ''), { flag: 'w' });
  } catch (error) {
    console.error(`Error writing ${name}:`, error);
  }
};

const stopSpawnedPid = (pid: number | null | undefined) => {
  if (pid == null) return;
  try {
    if (isWindows) {
      const { execSync } = require('child_process');
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGINT');
    }
  } catch (error) {
    console.error(`Error stopping spawned PID ${pid}:`, error);
  }
};

const startAndWatchJob = (job: Job, attemptId: string) => {
  return new Promise<boolean>(async resolve => {
    const trainingRoot = await getTrainingFolder();
    const trainingFolder = path.join(trainingRoot, job.name);
    if (!fs.existsSync(trainingFolder)) {
      fs.mkdirSync(trainingFolder, { recursive: true });
    }

    const configPath = path.join(trainingFolder, '.job_config.json');
    const logPath = path.join(trainingFolder, 'log.txt');
    rotateLogFile(trainingFolder, logPath);

    const jobConfig = JSON.parse(job.job_config);
    jobConfig.config.process[0].sqlite_db_path = path.join(TOOLKIT_ROOT, 'aitk_db.db');

    fs.writeFileSync(configPath, JSON.stringify(jobConfig, null, 2));

    const assignment = resolveGpuAssignment(job);
    const pythonPath = getPythonPath();
    const runFilePath = path.join(TOOLKIT_ROOT, 'run.py');
    const workerFilePath = path.join(TOOLKIT_ROOT, 'run_sampling_worker.py');

    if (!fs.existsSync(runFilePath)) {
      console.error(`run.py not found at path: ${runFilePath}`);
      await finalizeAttempt(prisma, attemptId, {
        attemptStatus: 'error',
        jobStatus: 'error',
        info: 'Error launching job: run.py not found',
      });
      resolve(false);
      return;
    }

    const samplingSupport = getSamplingWorkerSupport(jobConfig);
    const shouldStartSamplingWorker =
      !assignment.isLegacyMode &&
      assignment.samplingGpuId != null &&
      samplingSupport.supported &&
      fs.existsSync(workerFilePath);

    const additionalEnv: NodeJS.ProcessEnv = {
      ...process.env,
      AITK_JOB_ID: job.id,
      AITK_ATTEMPT_ID: attemptId,
      AITK_USE_DEDICATED_SAMPLER: shouldStartSamplingWorker ? '1' : '0',
      CUDA_DEVICE_ORDER: 'PCI_BUS_ID',
      CUDA_VISIBLE_DEVICES: assignment.trainerVisibleGpuIds.join(','),
      IS_AI_TOOLKIT_UI: '1',
    };

    const hfToken = await getHFToken();
    if (hfToken && hfToken.trim() !== '') {
      additionalEnv.HF_TOKEN = hfToken;
    }

    let trainerPid: number | null = null;
    let samplerPid: number | null = null;

    try {
      const trainerArgs = [runFilePath, configPath, '--log', logPath];
      const trainerProcess = spawnDetachedProcess(pythonPath, trainerArgs, additionalEnv);
      trainerPid = trainerProcess.pid ?? null;

      await prisma.jobRunAttempt.update({
        where: { id: attemptId },
        data: {
          trainer_pid: trainerPid,
          heartbeat_at: new Date(),
          status: 'running',
        },
      });

      await prisma.job.update({
        where: { id: job.id },
        data: {
          pid: trainerPid,
          status: 'running',
          info: 'Training',
        },
      });

      maybeWritePidFile(trainingFolder, 'pid.txt', trainerPid);
      if (trainerProcess.unref) trainerProcess.unref();

      if (shouldStartSamplingWorker && assignment.samplingGpuId) {
        const samplerLogPath = path.join(trainingFolder, 'sampler.log');
        rotateLogFile(trainingFolder, samplerLogPath);

        const samplerEnv: NodeJS.ProcessEnv = {
          ...process.env,
          AITK_JOB_ID: job.id,
          AITK_ATTEMPT_ID: attemptId,
          AITK_CONFIG_PATH: configPath,
          AITK_DB_PATH: path.join(TOOLKIT_ROOT, 'aitk_db.db'),
          CUDA_DEVICE_ORDER: 'PCI_BUS_ID',
          CUDA_VISIBLE_DEVICES: assignment.samplingGpuId,
          IS_AI_TOOLKIT_UI: '1',
        };

        if (hfToken && hfToken.trim() !== '') {
          samplerEnv.HF_TOKEN = hfToken;
        }

        const samplerArgs = [workerFilePath, '--job-id', job.id, '--attempt-id', attemptId, '--log', samplerLogPath];
        const samplerProcess = spawnDetachedProcess(pythonPath, samplerArgs, samplerEnv);
        samplerPid = samplerProcess.pid ?? null;

        await prisma.jobRunAttempt.update({
          where: { id: attemptId },
          data: {
            sampler_pid: samplerPid,
            heartbeat_at: new Date(),
          },
        });

        await prisma.job.update({
          where: { id: job.id },
          data: {
            sampler_pid: samplerPid,
            info: 'Training with dedicated sampling GPU',
          },
        });

        maybeWritePidFile(trainingFolder, 'sampler_pid.txt', samplerPid);
        if (samplerProcess.unref) samplerProcess.unref();
      } else if (!assignment.isLegacyMode && assignment.samplingGpuId && !samplingSupport.supported) {
        await prisma.job.update({
          where: { id: job.id },
          data: {
            info: samplingSupport.reason ?? 'Training (sampling will run inline)',
          },
        });
      }

      await updateAttemptHeartbeat(prisma, attemptId);
      resolve(true);
    } catch (error: any) {
      console.error('Error launching process:', error);
      stopSpawnedPid(samplerPid);
      stopSpawnedPid(trainerPid);
      await finalizeAttempt(prisma, attemptId, {
        attemptStatus: 'error',
        jobStatus: 'error',
        info: `Error launching job: ${error?.message || 'Unknown error'}`,
      });
      resolve(false);
    }
  });
};

export default async function startJob(jobID: string) {
  const job = await prisma.job.findUnique({
    where: { id: jobID },
  });

  if (!job) {
    console.error(`Job with ID ${jobID} not found`);
    return false;
  }

  try {
    const attempt = await claimRunAttempt(prisma, job);
    if (!attempt) {
      return false;
    }
    return startAndWatchJob(job, attempt.id);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return false;
    }
    console.error(`Failed to claim run attempt for job ${jobID}:`, error);
    await prisma.job.update({
      where: { id: jobID },
      data: {
        status: 'error',
        info: error?.message || 'Failed to reserve GPUs for job',
      },
    });
    return false;
  }
}
