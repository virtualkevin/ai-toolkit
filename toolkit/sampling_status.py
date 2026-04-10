from typing import Any, Optional


def get_sampling_media_noun(config: Optional[Any]) -> str:
    num_frames = getattr(config, "num_frames", 1)
    return "videos" if num_frames > 1 else "images"


def get_sampling_progress_message(
    config: Optional[Any],
    current: Optional[int] = None,
    total: Optional[int] = None,
) -> str:
    noun = get_sampling_media_noun(config)
    if current is None or total is None:
        return f"Generating {noun}"
    return f"Generating {noun} - {current}/{total}"


def get_sampling_progress_desc(config: Optional[Any]) -> str:
    return get_sampling_progress_message(config).title()
