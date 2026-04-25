import ffmpeg
import os
import tempfile

from ffmpeg_utils import ensure_portable_ffmpeg_in_path
from source_separation import prepare_background_stem

TARGET_SAMPLE_RATE = 44100

ensure_portable_ffmpeg_in_path()

def get_audio_duration(file_path):
    try:
        probe = ffmpeg.probe(file_path)
        audio_stream = next((stream for stream in probe['streams'] if stream['codec_type'] == 'audio'), None)
        if audio_stream:
            return float(audio_stream['duration'])
        # Fallback to format duration if stream duration missing
        return float(probe['format']['duration'])
    except Exception as e:
        print(f"Error probing audio: {e}")
        return None


def _parse_ffmpeg_rate(rate_value):
    if not rate_value or rate_value in {"0/0", "N/A"}:
        return None
    try:
        if isinstance(rate_value, str) and "/" in rate_value:
            numerator, denominator = rate_value.split("/", 1)
            numerator_f = float(numerator)
            denominator_f = float(denominator)
            if denominator_f == 0:
                return None
            return numerator_f / denominator_f
        return float(rate_value)
    except Exception:
        return None


def get_video_frame_rate(video_path):
    try:
        probe = ffmpeg.probe(video_path)
        video_stream = next((stream for stream in probe['streams'] if stream.get('codec_type') == 'video'), None)
        if not video_stream:
            return None

        for key in ('avg_frame_rate', 'r_frame_rate'):
            rate = _parse_ffmpeg_rate(video_stream.get(key))
            if rate and rate > 0:
                return rate
    except Exception as error:
        print(f"[VideoFPS] Failed to probe source fps: {error}")
    return None

def align_audio(input_path, output_path, target_duration_sec):
    """
    Time-stretch audio to match target duration using ffmpeg atempo.
    :param input_path: Source audio file.
    :param output_path: Destination audio file.
    :param target_duration_sec: Desired duration in seconds.
    :return: True if successful, False otherwise.
    """
    current_duration = get_audio_duration(input_path)
    if current_duration is None:
        print("Could not determine input audio duration.")
        return False

    if target_duration_sec <= 0:
        print("Target duration must be positive.")
        return False

    speed_factor = current_duration / target_duration_sec
    print(f"Aligning: {current_duration:.2f}s -> {target_duration_sec:.2f}s (Speed Factor: {speed_factor:.2f}x)")

    tempo_filters = []
    remaining_factor = speed_factor

    while remaining_factor > 2.0:
        tempo_filters.append(2.0)
        remaining_factor /= 2.0
    while remaining_factor < 0.5:
        tempo_filters.append(0.5)
        remaining_factor /= 0.5
    
    if abs(remaining_factor - 1.0) > 0.01: # Only if not effectively 1.0
        tempo_filters.append(remaining_factor)

    try:
        stream = ffmpeg.input(input_path)
        
        for t in tempo_filters:
            stream = stream.filter('atempo', t)
            
        stream = ffmpeg.output(stream, output_path)
        ffmpeg.run(stream, overwrite_output=True, quiet=True)
        print(f"Aligned audio saved to {output_path}")
        return True
    except ffmpeg.Error as e:
        print(f"FFmpeg Error: {e.stderr.decode() if e.stderr else str(e)}")
        return False

def _ensure_stereo(audio):
    import numpy as np

    if audio.ndim == 1:
        audio = audio.reshape(1, -1)

    if audio.shape[0] == 1:
        audio = np.repeat(audio, 2, axis=0)
    elif audio.shape[0] > 2:
        audio = audio[:2, :]

    return audio.astype(np.float32, copy=False)


def _ensure_frame_major_stereo(audio):
    import numpy as np

    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim == 1:
        audio = np.stack([audio, audio], axis=1)
    elif audio.ndim == 2:
        if audio.shape[0] == 2 and audio.shape[1] != 2:
            audio = audio.T
        elif audio.shape[1] == 1:
            audio = np.repeat(audio, 2, axis=1)
        elif audio.shape[1] > 2:
            audio = audio[:, :2]
    return audio.astype(np.float32, copy=False)


def _apply_fade(audio, sample_rate, fade_ms=24):
    import numpy as np

    audio = _ensure_stereo(audio).copy()
    fade_samples = min(int(sample_rate * fade_ms / 1000), audio.shape[1] // 2)
    if fade_samples <= 0:
        return audio

    ramp = np.linspace(0.0, 1.0, fade_samples, dtype=np.float32)
    audio[:, :fade_samples] *= ramp
    audio[:, -fade_samples:] *= ramp[::-1]
    return audio


def _time_stretch_stereo(audio, sample_rate, target_duration_sec):
    audio = _ensure_stereo(audio)
    current_duration = audio.shape[1] / float(sample_rate)
    if target_duration_sec <= 0 or current_duration <= 0:
        return audio

    rate = current_duration / float(target_duration_sec)
    if abs(rate - 1.0) < 0.02:
        return audio

    import numpy as np
    import librosa

    stretched = []
    for channel in audio:
        stretched.append(librosa.effects.time_stretch(channel, rate=rate))

    stretched_audio = np.vstack(stretched)
    target_samples = max(1, int(round(target_duration_sec * sample_rate)))

    if stretched_audio.shape[1] > target_samples:
        stretched_audio = stretched_audio[:, :target_samples]
    elif stretched_audio.shape[1] < target_samples:
        pad_width = target_samples - stretched_audio.shape[1]
        stretched_audio = np.pad(stretched_audio, ((0, 0), (0, pad_width)))

    return stretched_audio.astype(np.float32, copy=False)


def _load_audio_file(audio_path, sample_rate):
    import librosa

    audio, _ = librosa.load(audio_path, sr=sample_rate, mono=False)
    return _ensure_stereo(audio)


def _extract_audio_chunk(source_path, start_time, duration, sample_rate, label="audio"):
    if duration <= 0:
        return None

    temp_audio_path = None
    try:
        fd, temp_audio_path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)

        ffmpeg.input(source_path, ss=start_time, t=duration).output(
            temp_audio_path,
            acodec="pcm_s16le",
            ac=2,
            ar=sample_rate,
            loglevel="error"
        ).run(overwrite_output=True, quiet=True)

        return _load_audio_file(temp_audio_path, sample_rate)
    except Exception as error:
        print(f"[Mixer] Failed to extract {label} chunk {start_time:.2f}-{start_time + duration:.2f}: {error}")
        return None
    finally:
        if temp_audio_path and os.path.exists(temp_audio_path):
            try:
                os.remove(temp_audio_path)
            except Exception:
                pass


def _extract_full_audio(source_path, sample_rate):
    temp_audio_path = None
    try:
        fd, temp_audio_path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)

        ffmpeg.input(source_path).output(
            temp_audio_path,
            acodec="pcm_s16le",
            ac=2,
            ar=sample_rate,
            loglevel="error"
        ).run(overwrite_output=True, quiet=True)

        return _load_audio_file(temp_audio_path, sample_rate)
    finally:
        if temp_audio_path and os.path.exists(temp_audio_path):
            try:
                os.remove(temp_audio_path)
            except Exception:
                pass


def _blend_segments(base_audio, processed_audio, start_idx, end_idx, feather_samples):
    import numpy as np

    if end_idx <= start_idx:
        return

    base_slice = base_audio[:, start_idx:end_idx]
    if processed_audio.ndim != 2:
        return

    target_length = base_slice.shape[1]
    if target_length <= 0:
        return

    if processed_audio.shape[1] == target_length:
        processed_slice = processed_audio
    else:
        safe_start = max(0, min(start_idx, processed_audio.shape[1]))
        safe_end = max(safe_start, min(end_idx, processed_audio.shape[1]))
        processed_slice = processed_audio[:, safe_start:safe_end]

        if processed_slice.shape[1] != target_length:
            usable = min(target_length, processed_slice.shape[1])
            if usable <= 0:
                return
            base_slice = base_slice[:, :usable]
            processed_slice = processed_slice[:, :usable]
            end_idx = start_idx + usable

    length = base_slice.shape[1]
    if length <= 0:
        return

    weights = np.ones(length, dtype=np.float32)
    fade = min(feather_samples, length // 2)
    if fade > 0:
        ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
        weights[:fade] = ramp
        weights[-fade:] = ramp[::-1]

    base_audio[:, start_idx:end_idx] = (
        base_slice * (1.0 - weights[None, :]) +
        processed_slice * weights[None, :]
    )


def _mix_into_buffer(buffer, audio, start_time, sample_rate, gain=1.0):
    import numpy as np

    audio = _ensure_stereo(audio)
    start_idx = max(0, int(round(start_time * sample_rate)))
    if start_idx >= buffer.shape[0]:
        return

    clip = (audio.T * gain).astype(np.float32, copy=False)
    end_idx = min(buffer.shape[0], start_idx + clip.shape[0])
    usable = clip[: max(0, end_idx - start_idx)]
    if usable.size == 0:
        return

    buffer[start_idx:end_idx] += usable


def _normalize_audio(audio):
    import numpy as np

    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 0.98:
        audio = audio * (0.98 / peak)
    return audio


def _write_audio_buffer(audio, sample_rate):
    import soundfile as sf

    fd, temp_audio_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    sf.write(temp_audio_path, audio, sample_rate)
    return temp_audio_path


def _mux_video_with_audio(video_source, audio_source, output_path):
    output_dir = os.path.dirname(os.path.abspath(output_path))
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
    video_input = ffmpeg.input(video_source)
    audio_input = ffmpeg.input(audio_source)
    stream = ffmpeg.output(video_input["v"], audio_input["a"], output_path, vcodec="copy", acodec="aac", shortest=None)
    ffmpeg.run(stream, overwrite_output=True, quiet=True)


def _build_dubbed_audio_buffer(total_duration, audio_segments, sample_rate):
    import numpy as np

    total_samples = int(total_duration * sample_rate) + 1
    dubbed_audio = np.zeros((total_samples, 2), dtype=np.float32)

    for index, segment in enumerate(audio_segments):
        file_path = segment.get("path")
        if not file_path or not os.path.exists(file_path):
            continue

        try:
            audio = _load_audio_file(file_path, sample_rate)
            audio = _apply_fade(audio, sample_rate, fade_ms=30)
            start_time = float(segment.get("timeline_start", segment.get("start", 0.0)))
            _mix_into_buffer(dubbed_audio, audio, start_time, sample_rate, gain=1.12)
            print(f"[Mixer] Mixed dubbed segment {index} at {start_time:.2f}s")
        except Exception as error:
            print(f"[Mixer] Failed to load dubbed segment {file_path}: {error}")

    return dubbed_audio


def _build_background_buffer(background_audio_path, total_duration, chunk_specs, sample_rate):
    import numpy as np

    total_samples = int(total_duration * sample_rate) + 1
    background_audio = np.zeros((total_samples, 2), dtype=np.float32)

    for index, spec in enumerate(chunk_specs):
        source_duration = float(spec.get("source_duration", 0.0))
        timeline_duration = float(spec.get("timeline_duration", source_duration))
        if source_duration <= 0 or timeline_duration <= 0:
            continue

        chunk = _extract_audio_chunk(
            background_audio_path,
            float(spec.get("source_start", 0.0)),
            source_duration,
            sample_rate,
            label="background"
        )
        if chunk is None:
            continue

        chunk = _time_stretch_stereo(chunk, sample_rate, timeline_duration)
        chunk = _apply_fade(chunk, sample_rate, fade_ms=18)

        _mix_into_buffer(background_audio, chunk, float(spec.get("timeline_start", 0.0)), sample_rate, gain=1.0)
        print(
            f"[Mixer] Mixed background chunk {index}: "
            f"src={spec.get('source_start', 0.0):.2f}s/{source_duration:.2f}s -> "
            f"timeline={spec.get('timeline_start', 0.0):.2f}s/{timeline_duration:.2f}s"
        )

    return background_audio


def _build_full_background_mix(background_audio_path, total_duration, sample_rate):
    original_audio = _extract_full_audio(background_audio_path, sample_rate)
    original_audio = _ensure_stereo(original_audio)
    target_samples = int(total_duration * sample_rate) + 1

    if original_audio.shape[1] > target_samples:
        original_audio = original_audio[:, :target_samples]
    elif original_audio.shape[1] < target_samples:
        import numpy as np
        original_audio = np.pad(original_audio, ((0, 0), (0, target_samples - original_audio.shape[1])))

    return _ensure_frame_major_stereo(original_audio)


def _build_auto_background_specs(video_duration, audio_segments):
    specs = []
    cursor = 0.0

    for segment in sorted(audio_segments, key=lambda item: float(item.get("start", 0.0))):
        start_time = float(segment.get("start", 0.0))
        segment_duration = float(segment.get("duration") or 0.0)
        if segment_duration <= 0:
            end_time = float(segment.get("end", start_time))
            segment_duration = max(0.0, end_time - start_time)

        if start_time > cursor:
            gap_duration = start_time - cursor
            specs.append({
                "source_start": cursor,
                "source_duration": gap_duration,
                "timeline_start": cursor,
                "timeline_duration": gap_duration
            })

        specs.append({
            "source_start": start_time,
            "source_duration": segment_duration,
            "timeline_start": start_time,
            "timeline_duration": segment_duration
        })
        cursor = max(cursor, start_time + segment_duration)

    if cursor < video_duration:
        tail_duration = video_duration - cursor
        specs.append({
            "source_start": cursor,
            "source_duration": tail_duration,
            "timeline_start": cursor,
            "timeline_duration": tail_duration
        })

    return specs


def _finalize_mix(video_source_path, audio_segments, output_path, total_duration, audio_mix_mode, background_specs=None):
    if audio_mix_mode == "replace_original":
        return True

    import numpy as np

    temp_audio_path = None
    temp_output_path = None
    try:
        separation_result = prepare_background_stem(video_source_path, output_path)
        dubbed_audio = _build_dubbed_audio_buffer(total_duration, audio_segments, TARGET_SAMPLE_RATE)
        dubbed_audio = _ensure_frame_major_stereo(dubbed_audio)
        background_audio = _build_background_buffer(
            separation_result["background_path"],
            total_duration,
            background_specs or _build_auto_background_specs(total_duration, audio_segments),
            TARGET_SAMPLE_RATE
        )
        background_audio = _ensure_frame_major_stereo(background_audio)
        mixed_audio = _normalize_audio(dubbed_audio + background_audio)

        temp_audio_path = _write_audio_buffer(mixed_audio, TARGET_SAMPLE_RATE)
        fd, temp_output_path = tempfile.mkstemp(suffix=".mp4")
        os.close(fd)
        os.remove(temp_output_path)

        print("[PROGRESS] 50", flush=True)
        _mux_video_with_audio(output_path, temp_audio_path, temp_output_path)
        os.replace(temp_output_path, output_path)
        temp_output_path = None
        print("[PROGRESS] 100", flush=True)
        return True
    except Exception as error:
        print(f"Error finalizing preserve-background mix: {error}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        if temp_audio_path and os.path.exists(temp_audio_path):
            try:
                os.remove(temp_audio_path)
            except Exception:
                pass
        if temp_output_path and os.path.exists(temp_output_path):
            try:
                os.remove(temp_output_path)
            except Exception:
                pass


def merge_audios_to_video(video_path, audio_segments, output_path, strategy='auto_speedup', audio_mix_mode='preserve_background'):
    """
    Merge multiple audio segments into a final video.

    audio_mix_mode:
      - preserve_background: keep the separated background stem and discard the original narration track
      - replace_original: replace the original track with dubbed audio only
    """
    temp_mixed_path = None
    try:
        import numpy as np

        if not audio_segments:
            print("No audio segments provided.")
            return False

        if strategy and strategy != 'auto_speedup':
            return merge_video_advanced(video_path, audio_segments, output_path, strategy, audio_mix_mode=audio_mix_mode)

        try:
            probe = ffmpeg.probe(video_path)
            video_duration = float(probe['format']['duration'])
        except Exception as error:
            print(f"Error probing video duration: {error}")
            return False

        print(f"[Mixer] Initialized auto-speedup merge: {video_duration:.2f}s", flush=True)
        dubbed_audio = _build_dubbed_audio_buffer(video_duration, audio_segments, TARGET_SAMPLE_RATE)
        dubbed_audio = _ensure_frame_major_stereo(dubbed_audio)

        if audio_mix_mode == 'preserve_background':
            separation_result = prepare_background_stem(video_path, output_path)
            background_audio = _build_full_background_mix(
                separation_result["background_path"],
                video_duration,
                TARGET_SAMPLE_RATE
            )
            background_audio = _ensure_frame_major_stereo(background_audio)
            mixed_audio = dubbed_audio + background_audio
        else:
            mixed_audio = dubbed_audio

        mixed_audio = _normalize_audio(mixed_audio)
        temp_mixed_path = _write_audio_buffer(mixed_audio, TARGET_SAMPLE_RATE)
        print(f"[Mixer] Saved temporary merged audio to {temp_mixed_path}")

        print("[PROGRESS] 50", flush=True)
        _mux_video_with_audio(video_path, temp_mixed_path, output_path)
        print("[PROGRESS] 100", flush=True)
        print(f"Final video saved to {output_path}", flush=True)
        return True
    except Exception as error:
        print(f"Error merging video: {error}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        if temp_mixed_path and os.path.exists(temp_mixed_path):
            try:
                os.remove(temp_mixed_path)
            except Exception:
                pass

def get_rife_executable():
    """Locate rife-ncnn-vulkan executable."""
    current_dir = os.path.dirname(os.path.abspath(__file__))
    
    candidates = [
        os.path.join(current_dir, "..", "models", "rife"),
        os.path.join(current_dir, "..", "..", "models", "rife"),
        os.path.join(current_dir, "models", "rife")
    ]
    
    rife_exe = None
    rife_model_path = None
    
    for root in candidates:
        if os.path.exists(root):
            for dirpath, dirnames, filenames in os.walk(root):
                for f in filenames:
                    if f.lower() == 'rife-ncnn-vulkan.exe':
                        rife_exe = os.path.join(dirpath, f)
                        if os.path.exists(os.path.join(dirpath, 'rife-v4.6')):
                             rife_model_path = 'rife-v4.6'
                        break
                if rife_exe: break
        if rife_exe: break
        
    return rife_exe, rife_model_path

def apply_rife_interpolation(input_path, output_path, target_duration):
    """
    Use RIFE to interpolate video to at least target_duration (conceptually).
    Actually RIFE doubles frames. We run it enough times so that 
    len(frames) / original_fps >= target_duration.
    """
    rife_exe, rife_model = get_rife_executable()
    if not rife_exe:
        print("[RIFE] Executable not found. Please download RIFE in Model Manager.")
        return False
        
    try:
        probe = ffmpeg.probe(input_path)
        video_stream = next((stream for stream in probe['streams'] if stream['codec_type'] == 'video'), None)
        orig_duration = float(probe['format']['duration'])
        if orig_duration < 0.01 and video_stream:
             orig_duration = float(video_stream.get('duration', 0.1))
    except:
        orig_duration = 0.1
        
    if orig_duration <= 0: orig_duration = 0.1
    
    raw_factor = target_duration / orig_duration
    
    import math
    if raw_factor <= 1.0:
        pass_count = 0
    else:
        pass_count = math.ceil(math.log2(raw_factor))
        
    if pass_count < 1: pass_count = 1
    
    print(f"[RIFE] Interpolating {input_path} ({orig_duration:.2f}s) to ~{target_duration:.2f}s. Factor={raw_factor:.2f}. Passes={pass_count}")
    
    current_in = input_path
    
    import math
    import shutil
    import subprocess
    import uuid

    rife_exe, rife_model = get_rife_executable()
    if not rife_exe:
        print("[RIFE] Executable not found. Please download RIFE in Model Manager.")
        return False
        
    # Get video info
    try:
        probe = ffmpeg.probe(input_path)
        video_stream = next((stream for stream in probe['streams'] if stream['codec_type'] == 'video'), None)
        
        # Get frame count and fps
        orig_frames = int(video_stream.get('nb_frames', 0))
        # If nb_frames is missing (common in some streams), estimate from duration * fps
        if orig_frames == 0:
             duration = float(video_stream.get('duration', probe['format']['duration']))
             fps_eval = video_stream.get('r_frame_rate', '30/1')
             if '/' in fps_eval:
                 num, den = map(int, fps_eval.split('/'))
                 fps = num / den
             else:
                 fps = float(fps_eval)
             orig_frames = int(duration * fps)
        else:
             fps_eval = video_stream.get('r_frame_rate', '30/1')
             if '/' in fps_eval:
                 num, den = map(int, fps_eval.split('/'))
                 fps = num / den
             else:
                 fps = float(fps_eval)

        orig_duration = float(probe['format']['duration'])
        if orig_duration <= 0: orig_duration = 0.1
        
    except Exception as e:
        print(f"[RIFE] Error probing input: {e}")
        return False

    # Calculate target frame count
    # scale_factor = target_duration / orig_duration
    # target_frames = orig_frames * scale_factor
    target_frames = int(orig_frames * (target_duration / orig_duration))
    
    # Sanity check
    if target_frames < orig_frames: target_frames = orig_frames # Should not happen with our "No Speedup" logic, but safety first
    if target_frames == orig_frames:
         # No interpolation needed? Just copy?
         # But maybe user wants "smoothness" via RIFE even if same duration? 
         # usually logic is duration change. If same, RIFE 1x is identity?
         pass

    print(f"[RIFE] Interpolating {input_path} ({orig_duration:.2f}s, {orig_frames} frames) -> {target_duration:.2f}s ({target_frames} frames). FPS: {fps}")

    # Setup Cache Directories
    # Use .cache/rife/work_<uuid>
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) # From backend/alignment.py -> Backend -> Root ? 
    # Actually explicit path provided by user: .cache/rife
    # Let's try to find root relative to this file: e:\VideoSyncMaster\backend\alignment.py -> e:\VideoSyncMaster
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cache_root = os.path.join(root_dir, '.cache', 'rife')
    
    unique_id = uuid.uuid4().hex[:8]
    work_dir = os.path.join(cache_root, f"work_{unique_id}")
    frames_in = os.path.join(work_dir, "frames_in")
    frames_out = os.path.join(work_dir, "frames_out")
    
    os.makedirs(frames_in, exist_ok=True)
    os.makedirs(frames_out, exist_ok=True)
    
    success = False
    
    try:
        # 1. Extract Frames
        print(f"  [RIFE] Extracting frames to {frames_in}...")
        (
            ffmpeg
            .input(input_path)
            .output(os.path.join(frames_in, '%08d.png'), **{'q:v': 2}) # High quality JPG or PNG. PNG is default if extension is png
            .run(quiet=True, overwrite_output=True)
        )
        
        # 2. Run RIFE
        cmd = [
            rife_exe,
            '-i', frames_in,
            '-o', frames_out,
            '-n', str(target_frames),
            '-g', '0' # Force GPU 0
        ]
        if rife_model:
            cmd.extend(['-m', rife_model])
            
        print(f"  [RIFE] Running interpolation (Target: {target_frames} frames)...")
        
        res = subprocess.run(
            cmd, 
            check=True, 
            stdout=subprocess.PIPE, 
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8', 
            errors='replace'
        )
        # print(res.stdout) 
        
        # 3. Assemble Video
        # Input: Interpolated frames. 
        # Output: Video with duration = target_duration.
        # So we must play 'target_frames' at 'fps' rate? 
        # Wait, if we keep 'fps', duration = target_frames / fps = (orig * scale) / fps = (time * fps * scale) / fps = time * scale = target_time.
        # Yes, keeping original FPS is correct for Slow Motion effect.
        
        print(f"  [RIFE] Encoding result to {output_path}...")
        (
            ffmpeg
            .input(os.path.join(frames_out, '%08d.png'), framerate=fps)
            .output(output_path, vcodec='libx264', pix_fmt='yuv420p', crf=18, r=fps) # crf 18 for high quality
            .run(quiet=True, overwrite_output=True)
        )
        
        success = True
        
    except subprocess.CalledProcessError as e:
        print(f"  [RIFE] Process Failed: {e.stderr}")
    except Exception as e:
        print(f"  [RIFE] Error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        # Cleanup
        if os.path.exists(work_dir):
            try:
                shutil.rmtree(work_dir)
            except Exception as e:
                 print(f"  [RIFE] Warning: Failed to cleanup temp dir {work_dir}: {e}")
                 
    return success

def merge_video_advanced(video_path, audio_segments, output_path, strategy, audio_mix_mode='preserve_background'):
    """
    Advanced video merging with frame rate conversion/blending.
    Reconstructs video timeline to match audio duration.
    """
    print(f"[AdvancedMerge] Starting with strategy: {strategy}")
    import subprocess
    import shutil
    
    try:
        # Pre-process segments: sort by start
        sorted_segments = sorted(audio_segments, key=lambda x: x['start'])
        
        # We need to build a list of (video_chunk_path, audio_chunk_path)
        clips_list = [] 
        
        # We'll use a working dir for temp chunks
        work_dir = os.path.dirname(output_path)
        chunk_dir = os.path.join(work_dir, "temp_chunks")
        if os.path.exists(chunk_dir):
            shutil.rmtree(chunk_dir)
        os.makedirs(chunk_dir, exist_ok=True)
        
        source_cursor = 0.0
        output_cursor = 0.0
        background_specs = []
        source_fps = get_video_frame_rate(video_path)
        chunk_output_args = {'b:v': '4M'}
        if source_fps and source_fps > 0:
            chunk_output_args['r'] = round(source_fps, 3)
            print(f"[AdvancedMerge] Preserving source fps: {chunk_output_args['r']}")
        else:
            print("[AdvancedMerge] Source fps unavailable, leaving chunk fps unchanged.")
        
        for i, seg in enumerate(sorted_segments):
            seg_start = float(seg['start'])
            seg_audio_path = seg['path']
            slot_dur = float(seg.get('duration', 0))
            
            if slot_dur <= 0.01:
                audio_len = get_audio_duration(seg_audio_path) or 3.0
                print(f"  [Seg {i}] Warning: Invalid slot_dur {slot_dur}, referencing audio len {audio_len}s")
                slot_dur = audio_len

            if seg_start > source_cursor:
                gap_dur = seg_start - source_cursor
                if gap_dur > 0.1: # Ignore tiny gaps (<0.1s, approx 3 frames)
                    print(f"  [Gap] {source_cursor:.2f}s -> {seg_start:.2f}s ({gap_dur:.2f}s)")
                    v_chunk = os.path.join(chunk_dir, f"gap_{i}.mp4")
                    
                    try:
                        input_v = ffmpeg.input(video_path, ss=source_cursor, t=gap_dur)['v']
                        input_a = ffmpeg.input(f"anullsrc=channel_layout=stereo:sample_rate=44100", f='lavfi', t=gap_dur)
                        
                        (
                            ffmpeg
                            .output(input_v, input_a, v_chunk, vcodec='libx264', acodec='aac', ac=2, ar=44100, **chunk_output_args, preset='fast', shortest=None)
                            .run(overwrite_output=True, quiet=True)
                        )
                        clips_list.append(v_chunk)
                        background_specs.append({
                            "source_start": source_cursor,
                            "source_duration": gap_dur,
                            "timeline_start": output_cursor,
                            "timeline_duration": gap_dur
                        })
                        output_cursor += gap_dur
                    except ffmpeg.Error as e:
                        print(f"Gap generation error: {e.stderr.decode() if e.stderr else str(e)}")
                
                source_cursor = seg_start
            
            effective_video_start = max(seg_start, source_cursor)
            
            seg_audio_dur = get_audio_duration(seg_audio_path) or 0.1
            
            scale_factor = seg_audio_dur / slot_dur
            
            print(f"  [Seg {i}] Source: {effective_video_start:.2f}s (+{slot_dur:.2f}s) | Audio: {seg_audio_dur:.2f}s | Factor: {scale_factor:.2f}x")
            
            v_chunk_seg = os.path.join(chunk_dir, f"seg_{i}.mp4")
            
            stream_v = ffmpeg.input(video_path, ss=effective_video_start, t=slot_dur)['v']
            stream_a = ffmpeg.input(seg_audio_path)
            
            v_filters = []
            
            if scale_factor > 1.05 and strategy != 'auto_speedup':
                if strategy == 'frame_blend':
                    v_filters.append(('setpts', [f"{scale_factor}*PTS"], {}))
                    v_filters.append(('minterpolate', [], {'mi_mode': 'blend'}))
                elif strategy == 'freeze_frame':
                    pad_dur = seg_audio_dur - slot_dur
                    if pad_dur > 0:
                        v_filters.append(('tpad', [], {'stop_mode': 'clone', 'stop_duration': str(pad_dur + 0.5)}))
                elif strategy == 'rife':
                     raw_chunk = os.path.join(chunk_dir, f"rife_in_{i}.mp4")
                     rife_out = os.path.join(chunk_dir, f"rife_out_{i}.mp4")
                     
                     rife_success = False
                     try:
                         (
                            ffmpeg
                            .input(video_path, ss=effective_video_start, t=slot_dur)
                            .output(raw_chunk, vcodec='libx264', preset='fast', an=None)
                            .run(overwrite_output=True, quiet=True)
                         )
                         
                         if apply_rife_interpolation(raw_chunk, rife_out, seg_audio_dur):
                             rife_success = True
                             stream_v = ffmpeg.input(rife_out)['v']
                             try: os.remove(raw_chunk)
                             except: pass
                     except Exception as e:
                         print(f"  [Seg {i}] RIFE prep failed: {e}")
                     
                     if not rife_success:
                         v_filters.append(('setpts', [f"{scale_factor}*PTS"], {}))
            
            elif abs(scale_factor - 1.0) > 0.02:
                 v_filters.append(('setpts', [f"{scale_factor}*PTS"], {}))

            # Apply filters
            output_args = {
                'vcodec': 'libx264', 
                'acodec': 'aac', 
                'ac': 2,
                'ar': 44100,
                'preset': 'fast',
            }
            output_args.update(chunk_output_args)
            
            target_dur = slot_dur * scale_factor
            if target_dur > 0:
                 output_args['t'] = target_dur
            
            out_stream = stream_v
            if v_filters:
                for fname, fargs, fkwargs in v_filters:
                    out_stream = out_stream.filter(fname, *fargs, **fkwargs)

            try:
                (
                    ffmpeg
                    .output(out_stream, stream_a, v_chunk_seg, **output_args)
                    .run(overwrite_output=True, quiet=True)
                )
                clips_list.append(v_chunk_seg)
                seg['timeline_start'] = output_cursor
                seg['timeline_duration'] = target_dur
                background_specs.append({
                    "source_start": effective_video_start,
                    "source_duration": slot_dur,
                    "timeline_start": output_cursor,
                    "timeline_duration": target_dur
                })
                output_cursor += target_dur
            except ffmpeg.Error as e:
                 print(f"Seg generation error {i}: {e.stderr.decode() if e.stderr else str(e)}")
            
            source_cursor = effective_video_start + slot_dur
            
        probe = ffmpeg.probe(video_path)
        total_duration = float(probe['format']['duration'])
        
        if source_cursor < total_duration - 0.1:
            tail_dur = total_duration - source_cursor
            print(f"  [Tail] {source_cursor:.2f}s -> {total_duration:.2f}s")
            v_chunk = os.path.join(chunk_dir, "tail.mp4")
            try:
                input_v = ffmpeg.input(video_path, ss=source_cursor, t=tail_dur)['v']
                input_a = ffmpeg.input(f"anullsrc=channel_layout=stereo:sample_rate=44100", f='lavfi', t=tail_dur)
                (
                    ffmpeg
                    .output(input_v, input_a, v_chunk, vcodec='libx264', acodec='aac', ac=2, ar=44100, **chunk_output_args, preset='fast', shortest=None)
                    .run(overwrite_output=True, quiet=True)
                )
                clips_list.append(v_chunk)
                background_specs.append({
                    "source_start": source_cursor,
                    "source_duration": tail_dur,
                    "timeline_start": output_cursor,
                    "timeline_duration": tail_dur
                })
                output_cursor += tail_dur
            except Exception as e:
                print(f"Tail error: {e}")

        if not clips_list:
            print("No clips generated.")
            return False
            
        print(f"Concatenating {len(clips_list)} clips...")
        
        concat_list_path = os.path.join(chunk_dir, "concat.txt")
        with open(concat_list_path, 'w', encoding='utf-8') as f:
            for clip in clips_list:
                safe_path = clip.replace('\\', '/')
                f.write(f"file '{safe_path}'\n")
        
        try:
            (
                ffmpeg
                .input(concat_list_path, format='concat', safe=0)
                .output(output_path, c='copy')
                .run(overwrite_output=True, quiet=True)
            )
            print(f"Advanced merge complete: {output_path}")
        except ffmpeg.Error as e:
            print(f"Concat error: {e.stderr.decode() if e.stderr else str(e)}")
            return False

        if audio_mix_mode == 'preserve_background':
            final_duration = output_cursor if output_cursor > 0 else get_audio_duration(output_path)
            if not final_duration:
                final_duration = get_audio_duration(output_path) or 0.0
            if final_duration <= 0:
                print("[AdvancedMerge] Unable to determine final duration for preserve-background mix.")
                return False

            if not _finalize_mix(
                video_path,
                audio_segments,
                output_path,
                final_duration,
                audio_mix_mode,
                background_specs=background_specs
            ):
                return False
            
        try:
            shutil.rmtree(chunk_dir)
        except Exception:
            pass
            
    except Exception as e:
        print(f"Advanced merge failed: {e}")
        import traceback
        traceback.print_exc()
        return False
        
    return True

