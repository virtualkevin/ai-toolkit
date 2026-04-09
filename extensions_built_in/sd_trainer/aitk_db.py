import json
import sqlite3
import time
from typing import Any, Dict, Optional
from uuid import uuid4


def retry_db_operation(operation_func, max_retries=3, base_delay=2.0):
    last_error = None
    for attempt in range(max_retries + 1):
        try:
            return operation_func()
        except sqlite3.OperationalError as error:
            if "database is locked" not in str(error):
                raise
            last_error = error
            if attempt < max_retries:
                time.sleep(base_delay * (2 ** attempt))
            else:
                raise last_error


def db_connect(sqlite_db_path: str):
    conn = sqlite3.connect(sqlite_db_path, timeout=30.0)
    conn.isolation_level = None
    conn.row_factory = sqlite3.Row
    return conn


def update_job(sqlite_db_path: str, job_id: str, **fields):
    if not fields:
        return

    def _do_update():
        with db_connect(sqlite_db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("BEGIN IMMEDIATE")
            try:
                assignments = ", ".join([f"{key} = ?" for key in fields.keys()])
                values = list(fields.values()) + [job_id]
                cursor.execute(f"UPDATE Job SET {assignments} WHERE id = ?", values)
            finally:
                cursor.execute("COMMIT")

    retry_db_operation(_do_update)


def update_attempt(sqlite_db_path: str, attempt_id: str, **fields):
    if not fields:
        return

    def _do_update():
        with db_connect(sqlite_db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("BEGIN IMMEDIATE")
            try:
                assignments = ", ".join([f"{key} = ?" for key in fields.keys()])
                values = list(fields.values()) + [attempt_id]
                cursor.execute(f"UPDATE JobRunAttempt SET {assignments} WHERE id = ?", values)
            finally:
                cursor.execute("COMMIT")

    retry_db_operation(_do_update)


def enqueue_sample_task(
    sqlite_db_path: str,
    attempt_id: str,
    job_id: str,
    step: int,
    task_kind: str,
    artifact_kind: str,
    artifact_path: Optional[str],
    frozen_config: Dict[str, Any],
    cleanup_on_complete: bool = False,
):
    def _enqueue():
        with db_connect(sqlite_db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("BEGIN IMMEDIATE")
            try:
                cursor.execute(
                    "SELECT COALESCE(MAX(sequence), 0) FROM SampleTask WHERE attempt_id = ?",
                    (attempt_id,),
                )
                next_sequence = int(cursor.fetchone()[0]) + 1
                cursor.execute(
                    """
                    INSERT INTO SampleTask (
                        id,
                        attempt_id,
                        job_id,
                        sequence,
                        step,
                        task_kind,
                        artifact_kind,
                        artifact_path,
                        frozen_config,
                        status,
                        cleanup_on_complete
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
                    """,
                    (
                        str(uuid4()),
                        attempt_id,
                        job_id,
                        next_sequence,
                        step,
                        task_kind,
                        artifact_kind,
                        artifact_path,
                        json.dumps(frozen_config),
                        1 if cleanup_on_complete else 0,
                    ),
                )
                cursor.execute(
                    "SELECT id FROM SampleTask WHERE attempt_id = ? AND sequence = ?",
                    (attempt_id, next_sequence),
                )
                task_id = cursor.fetchone()[0]
            finally:
                cursor.execute("COMMIT")
        return task_id

    return retry_db_operation(_enqueue)


def claim_next_sample_task(sqlite_db_path: str, attempt_id: str):
    def _claim():
        with db_connect(sqlite_db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("BEGIN IMMEDIATE")
            try:
                cursor.execute(
                    """
                    SELECT id
                    FROM SampleTask
                    WHERE attempt_id = ? AND status = 'pending'
                    ORDER BY sequence ASC
                    LIMIT 1
                    """,
                    (attempt_id,),
                )
                row = cursor.fetchone()
                if row is None:
                    return None

                cursor.execute(
                    """
                    UPDATE SampleTask
                    SET status = 'running', started_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (row["id"],),
                )
                cursor.execute("SELECT * FROM SampleTask WHERE id = ?", (row["id"],))
                return dict(cursor.fetchone())
            finally:
                cursor.execute("COMMIT")

    return retry_db_operation(_claim)


def complete_sample_task(sqlite_db_path: str, task_id: str):
    def _complete():
        with db_connect(sqlite_db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("BEGIN IMMEDIATE")
            try:
                cursor.execute(
                    """
                    UPDATE SampleTask
                    SET status = 'completed', completed_at = CURRENT_TIMESTAMP, error = NULL
                    WHERE id = ?
                    """,
                    (task_id,),
                )
            finally:
                cursor.execute("COMMIT")

    retry_db_operation(_complete)


def fail_sample_task(sqlite_db_path: str, task_id: str, error_message: str):
    def _fail():
        with db_connect(sqlite_db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("BEGIN IMMEDIATE")
            try:
                cursor.execute(
                    """
                    UPDATE SampleTask
                    SET status = 'error', completed_at = CURRENT_TIMESTAMP, error = ?
                    WHERE id = ?
                    """,
                    (error_message, task_id),
                )
            finally:
                cursor.execute("COMMIT")

    retry_db_operation(_fail)


def reset_running_sample_tasks(sqlite_db_path: str, attempt_id: str, reason: str):
    def _reset():
        with db_connect(sqlite_db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("BEGIN IMMEDIATE")
            try:
                cursor.execute(
                    """
                    UPDATE SampleTask
                    SET status = 'pending', started_at = NULL, error = ?
                    WHERE attempt_id = ? AND status = 'running'
                    """,
                    (reason, attempt_id),
                )
            finally:
                cursor.execute("COMMIT")

    retry_db_operation(_reset)


def count_open_sample_tasks(sqlite_db_path: str, attempt_id: str):
    def _count():
        with db_connect(sqlite_db_path) as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT COUNT(*)
                FROM SampleTask
                WHERE attempt_id = ? AND status IN ('pending', 'running')
                """,
                (attempt_id,),
            )
            return int(cursor.fetchone()[0])

    return retry_db_operation(_count)


def get_job_flags(sqlite_db_path: str, job_id: str):
    def _get():
        with db_connect(sqlite_db_path) as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT stop, return_to_queue, status FROM Job WHERE id = ?",
                (job_id,),
            )
            row = cursor.fetchone()
            return dict(row) if row is not None else None

    return retry_db_operation(_get)


def get_attempt_state(sqlite_db_path: str, attempt_id: str):
    def _get():
        with db_connect(sqlite_db_path) as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT status, trainer_pid, sampler_pid FROM JobRunAttempt WHERE id = ?",
                (attempt_id,),
            )
            row = cursor.fetchone()
            return dict(row) if row is not None else None

    return retry_db_operation(_get)
