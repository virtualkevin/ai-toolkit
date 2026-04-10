import os
import sys
import unittest
from types import SimpleNamespace


sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from toolkit.sampling_status import (
    get_sampling_media_noun,
    get_sampling_progress_desc,
    get_sampling_progress_message,
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


if __name__ == "__main__":
    unittest.main()
