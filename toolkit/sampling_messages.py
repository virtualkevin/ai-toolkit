def get_generation_media_type(num_frames: int) -> str:
    return "videos" if num_frames > 1 else "images"


def format_generation_status(*, num_frames: int, current: int, total: int) -> str:
    return f"Generating {get_generation_media_type(num_frames)} - {current}/{total}"
