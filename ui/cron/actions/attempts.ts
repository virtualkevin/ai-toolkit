import { Job, PrismaClient } from '@prisma/client';
import { resolveGpuAssignment } from '../../lib/jobGpu';

const ACTIVE_ATTEMPT_STATUSES = ['starting', 'running', 'stopping'];
const ACTIVE_SAMPLE_TASK_STATUSES = ['pending', 'running'];

export const isPidAlive = (pid: number | null | undefined) => {
  if (pid == null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const getActiveAttemptForJob = async (prisma: PrismaClient, jobId: string) => {
  return prisma.jobRunAttempt.findFirst({
    where: {
      job_id: jobId,
      status: { in: ACTIVE_ATTEMPT_STATUSES },
    },
    orderBy: {
      started_at: 'desc',
    },
  });
};

export const claimRunAttempt = async (prisma: PrismaClient, job: Job) => {
  const assignment = resolveGpuAssignment(job);

  return prisma.$transaction(async tx => {
    const existingAttempt = await tx.jobRunAttempt.findFirst({
      where: {
        job_id: job.id,
        status: { in: ACTIVE_ATTEMPT_STATUSES },
      },
    });

    if (existingAttempt) {
      return null;
    }

    const attempt = await tx.jobRunAttempt.create({
      data: {
        job_id: job.id,
        status: 'starting',
        heartbeat_at: new Date(),
      },
    });

    for (const [index, gpuId] of assignment.reservationGpuIds.entries()) {
      await tx.gpuReservation.create({
        data: {
          gpu_id: gpuId,
          role: index === 0 ? 'training' : 'sampling',
          attempt_id: attempt.id,
        },
      });
    }

    await tx.job.update({
      where: { id: job.id },
      data: {
        status: 'starting',
        stop: false,
        return_to_queue: false,
        info: 'Starting job...',
        pid: null,
        sampler_pid: null,
      },
    });

    return attempt;
  });
};

export const finalizeAttempt = async (
  prisma: PrismaClient,
  attemptId: string,
  options: {
    attemptStatus: string;
    jobStatus: string;
    info: string;
    cancelSampleTasks?: boolean;
  },
) => {
  const attempt = await prisma.jobRunAttempt.findUnique({
    where: { id: attemptId },
    include: {
      job: true,
    },
  });

  if (!attempt) return;

  await prisma.$transaction(async tx => {
    await tx.gpuReservation.deleteMany({
      where: { attempt_id: attemptId },
    });

    if (options.cancelSampleTasks ?? true) {
      await tx.sampleTask.updateMany({
        where: {
          attempt_id: attemptId,
          status: { in: ACTIVE_SAMPLE_TASK_STATUSES },
        },
        data: {
          status: 'canceled',
          completed_at: new Date(),
          error: options.info,
        },
      });
    }

    await tx.jobRunAttempt.update({
      where: { id: attemptId },
      data: {
        status: options.attemptStatus,
        finished_at: new Date(),
        heartbeat_at: new Date(),
      },
    });

    await tx.job.update({
      where: { id: attempt.job_id },
      data: {
        status: options.jobStatus,
        info: options.info,
        pid: null,
        sampler_pid: null,
        stop: options.jobStatus === 'stopped',
      },
    });
  });
};

export const reconcileActiveAttempts = async (prisma: PrismaClient) => {
  const attempts = await prisma.jobRunAttempt.findMany({
    where: {
      status: { in: ACTIVE_ATTEMPT_STATUSES },
    },
    include: {
      job: true,
      sample_tasks: {
        where: {
          status: { in: ACTIVE_SAMPLE_TASK_STATUSES },
        },
      },
    },
  });

  for (const attempt of attempts) {
    const startedAt = new Date(attempt.started_at).getTime();
    if (attempt.status === 'starting' && Date.now() - startedAt < 30_000) {
      continue;
    }

    const trainerAlive = isPidAlive(attempt.trainer_pid);
    const samplerAlive = isPidAlive(attempt.sampler_pid);
    const hasOutstandingSampleTasks = attempt.sample_tasks.length > 0;

    if (trainerAlive || samplerAlive) {
      await prisma.jobRunAttempt.update({
        where: { id: attempt.id },
        data: {
          heartbeat_at: new Date(),
        },
      });
      continue;
    }

    if (attempt.job.return_to_queue) {
      await finalizeAttempt(prisma, attempt.id, {
        attemptStatus: 'stopped',
        jobStatus: 'queued',
        info: 'Job returned to queue',
      });
      continue;
    }

    if (attempt.job.stop) {
      await finalizeAttempt(prisma, attempt.id, {
        attemptStatus: 'stopped',
        jobStatus: 'stopped',
        info: 'Job stopped',
      });
      continue;
    }

    if (attempt.job.status === 'completed' && !hasOutstandingSampleTasks) {
      await finalizeAttempt(prisma, attempt.id, {
        attemptStatus: 'completed',
        jobStatus: 'completed',
        info: 'Training completed',
        cancelSampleTasks: false,
      });
      continue;
    }

    await finalizeAttempt(prisma, attempt.id, {
      attemptStatus: 'error',
      jobStatus: 'error',
      info: 'Job exited unexpectedly',
    });
  }
};

export const updateAttemptHeartbeat = async (prisma: PrismaClient, attemptId: string) => {
  await prisma.jobRunAttempt.update({
    where: { id: attemptId },
    data: {
      heartbeat_at: new Date(),
    },
  });
};
