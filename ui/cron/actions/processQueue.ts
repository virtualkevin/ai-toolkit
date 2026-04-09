import prisma from '../prisma';
import { Job, Queue } from '@prisma/client';
import startJob from './startJob';
import { reconcileActiveAttempts } from './attempts';
import { resolveGpuAssignment } from '../../lib/jobGpu';

const getQueueKey = (job: Job) => resolveGpuAssignment(job).queueKey;

export default async function processQueue() {
  await reconcileActiveAttempts(prisma);

  const queues: Queue[] = await prisma.queue.findMany({
    orderBy: {
      id: 'asc',
    },
  });

  for (const queue of queues) {
    const activeJobs = await prisma.job.findMany({
      where: {
        status: { in: ['queued', 'starting', 'running', 'stopping'] },
      },
      orderBy: {
        queue_position: 'asc',
      },
    });

    const matchingJobs = activeJobs.filter(job => getQueueKey(job) === queue.gpu_ids);

    if (!queue.is_running) {
      const runningJobs = matchingJobs.filter(job => ['starting', 'running'].includes(job.status));
      for (const job of runningJobs) {
        console.log(`Stopping job ${job.id} on queue ${queue.gpu_ids}`);
        await prisma.job.update({
          where: { id: job.id },
          data: {
            return_to_queue: true,
            stop: true,
            status: 'stopping',
            info: 'Stopping job...',
          },
        });
      }
      continue;
    }

    const runningJob = matchingJobs.find(job => ['starting', 'running', 'stopping'].includes(job.status));
    if (runningJob) {
      continue;
    }

    const queuedJobs = matchingJobs.filter(job => job.status === 'queued');
    if (queuedJobs.length === 0) {
      console.log(`No more jobs in queue for GPU(s) ${queue.gpu_ids}, stopping queue`);
      await prisma.queue.update({
        where: { id: queue.id },
        data: { is_running: false },
      });
      continue;
    }

    let startedAnyJob = false;
    for (const nextJob of queuedJobs) {
      console.log(`Attempting to start job ${nextJob.id} on queue ${queue.gpu_ids}`);
      const started = await startJob(nextJob.id);
      if (started) {
        startedAnyJob = true;
        break;
      }
    }

    if (!startedAnyJob) {
      console.log(`No runnable jobs available for queue ${queue.gpu_ids}; leaving queue running`);
    }
  }
}
