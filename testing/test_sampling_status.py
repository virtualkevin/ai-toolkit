import os
import sys
import unittest
from types import SimpleNamespace


sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from toolkit.sampling_status import (
    get_sampling_media_noun,
    get_sampling_progress_desc,
    get_sampling_progress_message,
    get_sampling_status_config,
)


class SamplingStatusTest(unittest.TestCase):
    def test_uses_images_for_single_frame_output(self):
        sample = SimpleNamespace(num_frames=1)

        self.assertEqual(get_sampling_media_noun(sample), "images")
        self.assertEqual(
            get_sampling_progress_message(sample, current=1, total=3),
            "Generating images - 1/3",
        )

    def test_uses_videos_for_multi_frame_output(self):
        sample = SimpleNamespace(num_frames=81)

        self.assertEqual(get_sampling_media_noun(sample), "videos")
        self.assertEqual(
            get_sampling_progress_message(sample, current=2, total=3),
            "Generating videos - 2/3",
        )
        self.assertEqual(get_sampling_progress_desc(sample), "Generating Videos")

    def test_initial_status_can_use_first_sample_item(self):
        samples = [
            SimpleNamespace(num_frames=49),
            SimpleNamespace(num_frames=1),
        ]

        self.assertEqual(
            get_sampling_progress_message(samples[0], current=0, total=2),
            "Generating videos - 0/2",
        )

    def test_process_status_uses_first_sample_config_when_requested(self):
        first_sample_configs = [SimpleNamespace(num_frames=49)]

        self.assertEqual(
            get_sampling_progress_message(
                get_sampling_status_config(first_sample_configs, sample_index=0),
                current=1,
                total=1,
            ),
            "Generating videos - 1/1",
        )

    def test_active_generation_configs_override_sample_items_for_status(self):
        sample_items = [SimpleNamespace(num_frames=1)]
        active_generation_configs = [SimpleNamespace(num_frames=81)]

        self.assertEqual(
            get_sampling_progress_message(
                get_sampling_status_config(active_generation_configs, sample_index=0),
                current=1,
                total=1,
            ),
            "Generating videos - 1/1",
        )
        self.assertEqual(
            get_sampling_progress_message(
                get_sampling_status_config(sample_items, sample_index=0),
                current=1,
                total=1,
            ),
            "Generating images - 1/1",
        )


if __name__ == "__main__":
    unittest.main()
