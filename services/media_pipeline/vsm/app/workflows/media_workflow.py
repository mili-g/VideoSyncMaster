from __future__ import annotations


def analyze_video_workflow(file_path, *, ffmpeg, exception_result):
    try:
        probe = ffmpeg.probe(file_path)
        video_stream = next((stream for stream in probe["streams"] if stream["codec_type"] == "video"), None)
        audio_stream = next((stream for stream in probe["streams"] if stream["codec_type"] == "audio"), None)

        info = {
            "format_name": probe["format"].get("format_name"),
            "duration": float(probe["format"].get("duration", 0)),
            "video_codec": video_stream["codec_name"] if video_stream else None,
            "audio_codec": audio_stream["codec_name"] if audio_stream else None,
            "width": int(video_stream["width"]) if video_stream else 0,
            "height": int(video_stream["height"]) if video_stream else 0,
        }
        return {"success": True, "info": info}
    except Exception as error:
        return exception_result(
            "ANALYZE_VIDEO_FAILED",
            "视频信息分析失败",
            error,
            category="media",
            stage="analyze_video",
            retryable=True,
        )


def transcode_video_workflow(
    input_path,
    output_path,
    *,
    ffmpeg,
    logger,
    logging,
    log_business,
    log_error,
    error_result,
    exception_result,
    make_error,
):
    log_business(logger, logging.INFO, "Starting video transcode", event="transcode_start", stage="transcode", detail=f"{input_path} -> {output_path}")
    try:
        stream = ffmpeg.input(input_path)
        stream = ffmpeg.output(stream, output_path, vcodec="libx264", acodec="aac", preset="fast", crf=23)
        ffmpeg.run(stream, overwrite_output=True, quiet=False)
        return {"success": True, "output": output_path}
    except ffmpeg.Error as error:
        err = error.stderr.decode() if error.stderr else str(error)
        log_error(logger, "Video transcode failed", event="transcode_failed", stage="transcode", detail=err, code="TRANSCODE_FAILED")
        return error_result(
            make_error(
                "TRANSCODE_FAILED",
                "视频转码失败",
                category="media",
                stage="transcode",
                retryable=False,
                detail=err,
            )
        )
    except Exception as error:
        log_error(logger, "Video transcode failed with exception", event="transcode_exception", stage="transcode", detail=str(error), code="TRANSCODE_EXCEPTION")
        return exception_result(
            "TRANSCODE_EXCEPTION",
            "视频转码失败",
            error,
            category="system",
            stage="transcode",
            retryable=False,
        )
