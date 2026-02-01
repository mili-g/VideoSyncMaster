import ffmpeg
import os
import ffmpeg
import os
import tempfile
# Lazy imports: numpy, soundfile, librosa

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

def merge_audios_to_video(video_path, audio_segments, output_path, strategy='auto_speedup'):
    """
    Merge multiple audio segments into a final video using Numpy for mixing.
    This avoids the 'Argument list too long' (WinError 206) issue with ffmpeg complex filters.
    
    :param video_path: Path to original video.
    :param audio_segments: List of dicts {'start': float, 'path': str}
    :param output_path: Path to save final video.
    """
    temp_mixed_path = None
    try:
        # Lazy imports for performance
        import numpy as np
        import librosa
        import soundfile as sf

        if not audio_segments:
            print("No audio segments provided.")
            return False

        if strategy and strategy != 'auto_speedup':
            return merge_video_advanced(video_path, audio_segments, output_path, strategy)


        # 1. Get video duration to initialize the audio buffer
        try:
            probe = ffmpeg.probe(video_path)
            video_duration = float(probe['format']['duration'])
        except Exception as e:
            print(f"Error probing video duration: {e}")
            return False
            
        target_sr = 44100
        total_samples = int(video_duration * target_sr) + 1
        
        mixed_audio = np.zeros((total_samples, 2), dtype=np.float32)

        print(f"[Mixer] Initialized buffer: {video_duration:.2f}s ({total_samples} samples)", flush=True)

        # 2. Mix audio segments        
        for i, seg in enumerate(audio_segments):
            start_time = seg['start']
            file_path = seg['path']
            
            # Start index
            start_idx = int(start_time * target_sr)
            print(f"[Mixer] Processing segment {i}: {file_path} (Start: {start_time}s)", flush=True)
            
            if start_idx >= total_samples:
                print(f"[Mixer] Warning: Segment {i} starts after video ends. Skipping.")
                continue

            try:
                # [MODIFIED] Dynamic alignment for auto_speedup without touching cache
                target_dur = seg.get('duration')
                final_file_path = file_path
                temp_segment_path = None
                
                if strategy == 'auto_speedup' and target_dur:
                    actual_dur = get_audio_duration(file_path)
                    if actual_dur and actual_dur > target_dur + 0.1:
                        fd, temp_segment_path = tempfile.mkstemp(suffix='.wav')
                        os.close(fd)
                        if align_audio(file_path, temp_segment_path, target_dur):
                            final_file_path = temp_segment_path
                            print(f"[Mixer] Segment {i} dynamically aligned: {actual_dur:.2f}s -> {target_dur:.2f}s")
                        else:
                            try: os.remove(temp_segment_path)
                            except: pass
                            temp_segment_path = None

                y, _ = librosa.load(final_file_path, sr=target_sr, mono=False)
                
                # Cleanup dynamic temp segment
                if temp_segment_path and os.path.exists(temp_segment_path):
                    try: os.remove(temp_segment_path)
                    except: pass
                
                if y.ndim == 1:
                    y = y.reshape(1, -1)
                
                if y.shape[0] == 1:
                    y = np.repeat(y, 2, axis=0)
                elif y.shape[0] > 2:
                    y = y[:2, :] 
                
                y = y.T 
                
                y = y * 1.2
                
                seg_samples = y.shape[0]
                
                end_idx = start_idx + seg_samples
                if end_idx > total_samples:
                    y = y[:total_samples - start_idx]
                    end_idx = total_samples
                
                mixed_audio[start_idx:end_idx] += y
                
            except Exception as e:
                print(f"[Mixer] Error processing segment {file_path}: {e}")
                continue

        max_val = np.max(np.abs(mixed_audio))
        if max_val > 1.0:
            print(f"[Mixer] Audio amplitude {max_val:.2f} > 1.0, normalizing.")
            mixed_audio = mixed_audio / max_val
        
        fd, temp_mixed_path = tempfile.mkstemp(suffix='.wav')
        os.close(fd)
        
        sf.write(temp_mixed_path, mixed_audio, target_sr)
        print(f"[Mixer] Saved temporary merged audio to {temp_mixed_path}")
        
        print("[PROGRESS] 50", flush=True)

        input_video = ffmpeg.input(video_path)
        input_audio = ffmpeg.input(temp_mixed_path)
        
        v = input_video['v']
        a = input_audio['a']
        
        stream = ffmpeg.output(v, a, output_path, vcodec='copy', acodec='aac', shortest=None)
        
        ffmpeg.run(stream, overwrite_output=True, quiet=False)
        print("[PROGRESS] 100", flush=True)
        print(f"Final video saved to {output_path}", flush=True)
        
        return True
        
    except Exception as e:
        print(f"Error merging video: {e}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        if temp_mixed_path and os.path.exists(temp_mixed_path):
            try:
                os.remove(temp_mixed_path)
            except:
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

def merge_video_advanced(video_path, audio_segments, output_path, strategy):
    """
    Advanced video merging with frame rate conversion/blending.
    Reconstructs video timeline to match audio duration.
    """
    print(f"[AdvancedMerge] Starting with strategy: {strategy}")
    import subprocess
    import shutil
    
    # helper to clean paths
    clean_paths = []
    
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
                            .output(input_v, input_a, v_chunk, vcodec='libx264', acodec='aac', ac=2, ar=44100, **{'b:v': '4M', 'r': 30}, preset='fast', shortest=None)
                            .run(overwrite_output=True, quiet=True)
                        )
                        clips_list.append(v_chunk)
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
                'b:v': '4M', 
                'preset': 'fast',
                'r': 30, # Enforce 30fps to avoid VFR sync issues in concat
            }
            
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
                    .output(input_v, input_a, v_chunk, vcodec='libx264', acodec='aac', ac=2, ar=44100, **{'b:v': '4M', 'r': 30}, preset='fast', shortest=None)
                    .run(overwrite_output=True, quiet=True)
                )
                clips_list.append(v_chunk)
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
            
        try:
            shutil.rmtree(chunk_dir)
        except: 
            pass
            
    except Exception as e:
        print(f"Advanced merge failed: {e}")
        import traceback
        traceback.print_exc()
        return False
        
    return True

