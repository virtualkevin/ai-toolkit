import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function GET(request: NextRequest, { params }: { params: { jobID: string } }) {
  const { jobID } = await params;

  const job = await prisma.job.findUnique({
    where: { id: jobID },
  });

  const activeAttempt = await prisma.jobRunAttempt.findFirst({
    where: {
      job_id: jobID,
      status: { in: ['starting', 'running', 'stopping'] },
    },
    orderBy: {
      started_at: 'desc',
    },
  });

  await prisma.$transaction(async tx => {
    if (activeAttempt) {
      await tx.gpuReservation.deleteMany({
        where: {
          attempt_id: activeAttempt.id,
        },
      });

      await tx.sampleTask.updateMany({
        where: {
          attempt_id: activeAttempt.id,
          status: { in: ['pending', 'running'] },
        },
        data: {
          status: 'canceled',
          completed_at: new Date(),
          error: 'Manually marked as stopped',
        },
      });

      await tx.jobRunAttempt.update({
        where: { id: activeAttempt.id },
        data: {
          status: 'stopped',
          finished_at: new Date(),
          heartbeat_at: new Date(),
        },
      });
    }

    await tx.job.update({
      where: { id: jobID },
      data: {
        stop: true,
        status: 'stopped',
        info: 'Job stopped',
        pid: null,
        sampler_pid: null,
      },
    });
  });

  console.log(`Job ${jobID} marked as stopped`);

  return NextResponse.json(job);
}
