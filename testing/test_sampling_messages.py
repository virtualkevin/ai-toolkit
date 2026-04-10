import os
import sys
import unittest

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from toolkit.sampling_messages import format_generation_status, get_generation_media_type


class TestSamplingMessages(unittest.TestCase):
    def test_generation_media_type_defaults_to_images_for_single_frame(self):
        self.assertEqual(get_generation_media_type(1), "images")

    def test_generation_media_type_uses_videos_for_multi_frame(self):
        self.assertEqual(get_generation_media_type(2), "videos")

    def test_format_generation_status_for_images(self):
        self.assertEqual(
            format_generation_status(num_frames=1, current=0, total=3),
            "Generating images - 0/3",
        )

    def test_format_generation_status_for_videos(self):
        self.assertEqual(
            format_generation_status(num_frames=8, current=2, total=3),
            "Generating videos - 2/3",
        )


if __name__ == "__main__":
    unittest.main()
