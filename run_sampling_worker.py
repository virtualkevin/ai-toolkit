import argparse
import os
import sys

from dotenv import load_dotenv

load_dotenv()
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = os.getenv("HF_HUB_ENABLE_HF_TRANSFER", "1")
os.environ["NO_ALBUMENTATIONS_UPDATE"] = "1"
os.environ['DISABLE_TELEMETRY'] = 'YES'

sys.path.insert(0, os.getcwd())

from toolkit.print import setup_log_to_file
from extensions_built_in.sd_trainer.sampling_worker import SamplingWorker


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", required=True, type=str)
    parser.add_argument("--attempt-id", required=True, type=str)
    parser.add_argument("--log", default=None, type=str)
    args = parser.parse_args()

    if args.log is not None:
        setup_log_to_file(args.log)

    sqlite_db_path = os.environ.get("AITK_DB_PATH", "./aitk_db.db")
    worker = SamplingWorker(sqlite_db_path=sqlite_db_path, job_id=args.job_id, attempt_id=args.attempt_id)
    worker.run()


if __name__ == "__main__":
    main()
