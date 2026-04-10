import os
import sys
import unittest
from types import SimpleNamespace


sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from toolkit.sampling_status import (
    get_sampling_media_noun,
    get_sampling_progress_desc,
    get_sampling_progress_message,
    get_sampling_progress_message_for_sources,
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

    def test_status_message_uses_first_sample_configs_as_fallback(self):
        first_sample_configs = [SimpleNamespace(num_frames=49)]

        self.assertEqual(
            get_sampling_progress_message_for_sources(
                current=2,
                total=3,
                sample_index=0,
                fallback_configs=first_sample_configs,
            ),
            "Generating videos - 2/3",
        )

    def test_active_generation_configs_override_fallback_sample_items(self):
        sample_items = [SimpleNamespace(num_frames=1)]
        active_generation_configs = [SimpleNamespace(num_frames=81)]

        self.assertEqual(
            get_sampling_progress_message_for_sources(
                current=1,
                total=1,
                sample_index=0,
                generation_configs=active_generation_configs,
                fallback_configs=sample_items,
            ),
            "Generating videos - 1/1",
        )
        self.assertEqual(
            get_sampling_progress_message_for_sources(
                current=1,
                total=1,
                sample_index=0,
                fallback_configs=sample_items,
            ),
            "Generating images - 1/1",
        )


if __name__ == "__main__":
    unittest.main()
