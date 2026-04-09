import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const isWindows = process.platform === 'win32';

const stopPid = (pid: number | null | undefined) => {
  if (pid == null) return;

  try {
    if (isWindows) {
      const { execSync } = require('child_process');
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGINT');
    }
  } catch (error) {
    console.error(`Error sending stop signal to PID ${pid}:`, error);
  }
};

export async function GET(request: NextRequest, { params }: { params: { jobID: string } }) {
  const { jobID } = await params;

  const job = await prisma.job.findUnique({
    where: { id: jobID },
  });

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  const activeAttempt = await prisma.jobRunAttempt.findFirst({
    where: {
      job_id: jobID,
      status: { in: ['starting', 'running', 'stopping'] },
    },
    orderBy: {
      started_at: 'desc',
    },
  });

  await prisma.job.update({
    where: { id: jobID },
    data: {
      stop: true,
      return_to_queue: false,
      status: 'stopping',
      info: 'Stopping job...',
    },
  });

  if (activeAttempt) {
    await prisma.jobRunAttempt.update({
      where: { id: activeAttempt.id },
      data: {
        status: 'stopping',
      },
    });
  }

  stopPid(activeAttempt?.trainer_pid ?? job.pid);
  stopPid(activeAttempt?.sampler_pid ?? job.sampler_pid);

  return NextResponse.json(job);
}
