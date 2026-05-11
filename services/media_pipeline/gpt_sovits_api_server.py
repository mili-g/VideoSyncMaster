from __future__ import annotations

import argparse
import gc
import math
import os
import signal
import sys
import traceback
from collections import defaultdict
from io import BytesIO
from pathlib import Path
from typing import List, Union

import numpy as np
import soundfile as sf
import torch
import uvicorn
from fastapi import FastAPI, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel


def _append_repo_paths(repo_root: Path) -> None:
    repo_root_str = repo_root.as_posix()
    gpt_root_str = (repo_root / "GPT_SoVITS").as_posix()
    if repo_root_str not in sys.path:
        sys.path.append(repo_root_str)
    if gpt_root_str not in sys.path:
        sys.path.append(gpt_root_str)


parser = argparse.ArgumentParser(description="VideoSync GPT-SoVITS API server")
parser.add_argument("-r", "--repo_root", type=str, required=True, help="GPT-SoVITS repository root")
parser.add_argument("-c", "--tts_config", type=str, required=True, help="tts_infer config path")
parser.add_argument("-a", "--bind_addr", type=str, default="127.0.0.1", help="default: 127.0.0.1")
parser.add_argument("-p", "--port", type=int, default=9880, help="default: 9880")
args = parser.parse_args()

repo_root = Path(args.repo_root).resolve()
config_path = str(Path(args.tts_config).resolve())
host = args.bind_addr
port = int(args.port)

_append_repo_paths(repo_root)

from tools.i18n.i18n import I18nAuto  # type: ignore  # noqa: E402
from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config  # type: ignore  # noqa: E402
from GPT_SoVITS.TTS_infer_pack.text_segmentation_method import (  # type: ignore  # noqa: E402
    get_method_names as get_cut_method_names,
    splits,
)

i18n = I18nAuto()
cut_method_names = get_cut_method_names()
tts_config = TTS_Config(config_path)

if torch.cuda.is_available():
    try:
        torch.backends.cuda.matmul.allow_tf32 = True
    except Exception:
        pass
    try:
        torch.backends.cudnn.allow_tf32 = True
    except Exception:
        pass
    try:
        torch.backends.cudnn.benchmark = True
    except Exception:
        pass
    try:
        torch.set_float32_matmul_precision("high")
    except Exception:
        pass

tts_pipeline = TTS(tts_config)
APP = FastAPI()
_REQUEST_COUNT = 0
_T2S_CUDAGRAPH_RUNNER = None
_T2S_CUDAGRAPH_ACTIVE_BATCH_SIZE = 0


def _release_gpu_memory() -> None:
    try:
        tts_pipeline.empty_cache()
    except Exception:
        pass
    if torch.cuda.is_available():
        try:
            torch.cuda.empty_cache()
        except Exception:
            pass
        try:
            torch.cuda.ipc_collect()
        except Exception:
            pass
    gc.collect()


def _maybe_release_gpu_memory(*, force: bool = False) -> None:
    global _REQUEST_COUNT
    _REQUEST_COUNT += 1
    if force:
        _release_gpu_memory()
        return

    should_trim = (_REQUEST_COUNT % 24) == 0
    if torch.cuda.is_available():
        try:
            free_bytes, total_bytes = torch.cuda.mem_get_info()
            free_ratio = (float(free_bytes) / float(total_bytes)) if total_bytes else 0.0
            if free_ratio < 0.10:
                should_trim = True
        except Exception:
            pass

    if should_trim:
        _release_gpu_memory()


class TTSRequest(BaseModel):
    text: str | None = None
    text_lang: str | None = None
    ref_audio_path: str | None = None
    aux_ref_audio_paths: list | None = None
    prompt_lang: str | None = None
    prompt_text: str = ""
    top_k: int = 15
    top_p: float = 1
    temperature: float = 1
    text_split_method: str = "cut5"
    batch_size: int = 20
    batch_threshold: float = 0.75
    split_bucket: bool = True
    speed_factor: float = 1.0
    fragment_interval: float = 0.3
    seed: int = -1
    media_type: str = "wav"
    streaming_mode: Union[bool, int] = False
    parallel_infer: bool = True
    repetition_penalty: float = 1.35
    sample_steps: int = 32
    super_sampling: bool = False
    overlap_length: int = 2
    min_chunk_length: int = 16
    official_fast_mode: bool = False
    use_cuda_graph: bool = False
    warmup_mode: bool = False


class BatchItem(BaseModel):
    index: int
    text: str
    output_path: str


class TTSBatchRequest(TTSRequest):
    items: list[BatchItem]


def pack_wav(io_buffer: BytesIO, data: np.ndarray, rate: int):
    sf.write(io_buffer, data, rate, format="wav")
    return io_buffer


def _check_params(req: dict):
    text = req.get("text")
    ref_audio_path = req.get("ref_audio_path")
    text_lang = req.get("text_lang")
    prompt_lang = req.get("prompt_lang")
    text_split_method = req.get("text_split_method", "cut5")
    media_type = req.get("media_type", "wav")

    if ref_audio_path in [None, ""]:
        return JSONResponse(status_code=400, content={"message": "ref_audio_path is required"})
    if text in [None, ""]:
        return JSONResponse(status_code=400, content={"message": "text is required"})
    if text_lang not in tts_config.languages:
        return JSONResponse(status_code=400, content={"message": f"text_lang:{text_lang} is not supported"})
    if prompt_lang not in tts_config.languages:
        return JSONResponse(status_code=400, content={"message": f"prompt_lang:{prompt_lang} is not supported"})
    if text_split_method not in cut_method_names:
        return JSONResponse(status_code=400, content={"message": f"text_split_method:{text_split_method} is not supported"})
    if media_type not in {"wav", "raw", "ogg", "aac"}:
        return JSONResponse(status_code=400, content={"message": f"media_type:{media_type} is not supported"})
    return None


def _prepare_prompt_cache(req: dict) -> None:
    ref_audio_path = req.get("ref_audio_path", "")
    aux_ref_audio_paths = req.get("aux_ref_audio_paths") or []
    prompt_text = str(req.get("prompt_text") or "")
    prompt_lang = req.get("prompt_lang")
    no_prompt_text = prompt_text in [None, ""]

    if no_prompt_text and tts_pipeline.configs.use_vocoder:
        raise ValueError("prompt_text cannot be empty when using SoVITS_V3")

    if ref_audio_path in [None, ""] and (
        (tts_pipeline.prompt_cache["prompt_semantic"] is None) or (tts_pipeline.prompt_cache["refer_spec"] in [None, []])
    ):
        raise ValueError("ref_audio_path cannot be empty, when the reference audio is not set using set_ref_audio()")

    if (ref_audio_path is not None) and (
        ref_audio_path != tts_pipeline.prompt_cache["ref_audio_path"]
        or (tts_pipeline.is_v2pro and tts_pipeline.prompt_cache["refer_spec"][0][1] is None)
    ):
        if not os.path.exists(ref_audio_path):
            raise ValueError(f"{ref_audio_path} not exists")
        tts_pipeline.set_ref_audio(ref_audio_path)

    paths = set(aux_ref_audio_paths) & set(tts_pipeline.prompt_cache["aux_ref_audio_paths"])
    if not (len(list(paths)) == len(aux_ref_audio_paths) == len(tts_pipeline.prompt_cache["aux_ref_audio_paths"])):
        tts_pipeline.prompt_cache["aux_ref_audio_paths"] = aux_ref_audio_paths
        tts_pipeline.prompt_cache["refer_spec"] = [tts_pipeline.prompt_cache["refer_spec"][0]]
        for path in aux_ref_audio_paths:
            if path in [None, ""]:
                continue
            if not os.path.exists(path):
                continue
            tts_pipeline.prompt_cache["refer_spec"].append(tts_pipeline._get_ref_spec(path))

    if no_prompt_text:
        return

    prompt_text = prompt_text.strip("\n")
    if prompt_text and prompt_text[-1] not in splits:
        prompt_text += "。" if prompt_lang != "en" else "."
    if tts_pipeline.prompt_cache["prompt_text"] != prompt_text:
        phones, bert_features, norm_text = tts_pipeline.text_preprocessor.segment_and_extract_feature_for_text(
            prompt_text,
            prompt_lang,
            tts_pipeline.configs.version,
        )
        tts_pipeline.prompt_cache["prompt_text"] = prompt_text
        tts_pipeline.prompt_cache["prompt_lang"] = prompt_lang
        tts_pipeline.prompt_cache["phones"] = phones
        tts_pipeline.prompt_cache["bert_features"] = bert_features
        tts_pipeline.prompt_cache["norm_text"] = norm_text


def _get_t2s_weights_path() -> str:
    path = getattr(tts_pipeline.configs, "t2s_weights_path", "") or getattr(tts_config, "t2s_weights_path", "")
    resolved = str(path or "").strip()
    if not resolved:
        raise RuntimeError("Missing GPT-SoVITS t2s weights path for CUDA Graph initialization")
    return resolved


def _get_cudagraph_runner(*, batch_size: int):
    global _T2S_CUDAGRAPH_RUNNER, _T2S_CUDAGRAPH_ACTIVE_BATCH_SIZE
    if not torch.cuda.is_available():
        return None

    requested_batch_size = max(1, int(batch_size or 1))
    max_batch_size = max(12, requested_batch_size)

    if _T2S_CUDAGRAPH_RUNNER is None:
        from AR.models.t2s_model_cudagraph import CUDAGraphRunner

        runner = CUDAGraphRunner(
            CUDAGraphRunner.load_decoder(_get_t2s_weights_path(), max_batch_size=max_batch_size),
            torch.device(tts_pipeline.configs.device),
            torch.float16 if tts_pipeline.precision == torch.float16 else torch.float32,
        )
        _T2S_CUDAGRAPH_RUNNER = runner

    runner = _T2S_CUDAGRAPH_RUNNER
    if runner is None:
        return None

    if requested_batch_size != _T2S_CUDAGRAPH_ACTIVE_BATCH_SIZE:
        runner.graph = None
        runner.xy_pos_ = torch.zeros(
            (requested_batch_size, 1, runner.decoder_model.embedding_dim),
            device=runner.device,
            dtype=runner.dtype,
        )
        runner.xy_dec_ = torch.zeros(
            (requested_batch_size, 1, runner.decoder_model.embedding_dim),
            device=runner.device,
            dtype=runner.dtype,
        )
        runner.kv_cache = runner.decoder_model.init_cache(requested_batch_size)
        runner.input_pos = torch.zeros((requested_batch_size,), device=runner.device, dtype=torch.int32)
        _T2S_CUDAGRAPH_ACTIVE_BATCH_SIZE = requested_batch_size
    return runner


def _run_t2s_with_cudagraph(
    *,
    batch_phones: List[torch.LongTensor],
    all_phoneme_ids: List[torch.LongTensor],
    all_phoneme_lens: torch.LongTensor,
    all_bert_features: List[torch.Tensor],
    prompt: torch.Tensor,
    top_k: int,
    top_p: float,
    temperature: float,
    repetition_penalty: float,
):
    runner = _get_cudagraph_runner(batch_size=len(all_phoneme_ids))
    if runner is None:
        raise RuntimeError("CUDA Graph runner unavailable")

    from AR.models.structs_cudagraph import T2SRequest

    request = T2SRequest(
        x=list(all_phoneme_ids),
        x_lens=all_phoneme_lens.to(torch.int32),
        prompts=prompt,
        bert_feature=list(all_bert_features),
        valid_length=len(all_phoneme_ids),
        top_k=top_k,
        top_p=top_p,
        temperature=temperature,
        early_stop_num=tts_pipeline.configs.hz * tts_pipeline.configs.max_sec,
        repetition_penalty=repetition_penalty,
        use_cuda_graph=True,
    )
    result = runner.generate(request)
    if result.exception is not None:
        raise RuntimeError(f"CUDA Graph T2S inference failed: {result.exception}")

    pred_semantic_list = list(result.result or [])
    if len(pred_semantic_list) != len(batch_phones):
        raise RuntimeError(
            f"CUDA Graph T2S returned unexpected result count: {len(pred_semantic_list)} != {len(batch_phones)}"
        )
    idx_list = []
    normalized_pred_semantics = []
    for semantic in pred_semantic_list:
        if semantic is None:
            raise RuntimeError("CUDA Graph T2S returned empty semantic result")
        normalized = semantic.to(tts_pipeline.configs.device)
        normalized_pred_semantics.append(normalized)
        idx_list.append(int(normalized.shape[0]))
    return normalized_pred_semantics, idx_list


def _synthesize_bucket(item: dict, *, top_k: int, top_p: float, temperature: float, repetition_penalty: float, speed_factor: float, sample_steps: int, parallel_infer: bool, use_cuda_graph: bool):
    batch_phones: List[torch.LongTensor] = item["phones"]
    all_phoneme_ids: List[torch.LongTensor] = item["all_phones"]
    all_phoneme_lens: torch.LongTensor = item["all_phones_len"]
    all_bert_features: List[torch.Tensor] = item["all_bert_features"]
    max_len = item["max_len"]
    prompt = tts_pipeline.prompt_cache["prompt_semantic"].expand(len(all_phoneme_ids), -1).to(tts_pipeline.configs.device)

    refer_audio_spec = []
    sv_emb = [] if tts_pipeline.is_v2pro else None
    for spec, audio_tensor in tts_pipeline.prompt_cache["refer_spec"]:
        spec = spec.to(dtype=tts_pipeline.precision, device=tts_pipeline.configs.device)
        refer_audio_spec.append(spec)
        if tts_pipeline.is_v2pro:
            sv_emb.append(tts_pipeline.sv_model.compute_embedding3(audio_tensor))

    if use_cuda_graph and torch.cuda.is_available() and len(all_phoneme_ids) == 1:
        pred_semantic_list, idx_list = _run_t2s_with_cudagraph(
            batch_phones=batch_phones,
            all_phoneme_ids=all_phoneme_ids,
            all_phoneme_lens=all_phoneme_lens,
            all_bert_features=all_bert_features,
            prompt=prompt,
            top_k=top_k,
            top_p=top_p,
            temperature=temperature,
            repetition_penalty=repetition_penalty,
        )
    else:
        pred_semantic_list, idx_list = tts_pipeline.t2s_model.model.infer_panel(
            all_phoneme_ids,
            all_phoneme_lens,
            prompt,
            all_bert_features,
            top_k=top_k,
            top_p=top_p,
            temperature=temperature,
            early_stop_num=tts_pipeline.configs.hz * tts_pipeline.configs.max_sec,
            max_len=max_len,
            repetition_penalty=repetition_penalty,
        )

    batch_audio_fragment = []
    if not tts_pipeline.configs.use_vocoder:
        if speed_factor == 1.0:
            pred_semantic_list = [segment[-idx:] for segment, idx in zip(pred_semantic_list, idx_list)]
            upsample_rate = math.prod(tts_pipeline.vits_model.upsample_rates)
            audio_frag_sizes = [pred_semantic_list[i].shape[0] * 2 * upsample_rate for i in range(len(pred_semantic_list))]
            audio_frag_end_idx = [sum(audio_frag_sizes[: i + 1]) for i in range(len(audio_frag_sizes))]
            all_pred_semantic = torch.cat(pred_semantic_list).unsqueeze(0).unsqueeze(0).to(tts_pipeline.configs.device)
            batch_phones_tensor = torch.cat(batch_phones).unsqueeze(0).to(tts_pipeline.configs.device)
            merged_audio = tts_pipeline.vits_model.decode(
                all_pred_semantic,
                batch_phones_tensor,
                refer_audio_spec,
                speed=speed_factor,
                sv_emb=sv_emb,
            ).detach()[0, 0, :]
            audio_frag_end_idx.insert(0, 0)
            batch_audio_fragment = [
                merged_audio[audio_frag_end_idx[i - 1] : audio_frag_end_idx[i]]
                for i in range(1, len(audio_frag_end_idx))
            ]
        else:
            for i, idx in enumerate(idx_list):
                phones = batch_phones[i].unsqueeze(0).to(tts_pipeline.configs.device)
                semantic = pred_semantic_list[i][-idx:].unsqueeze(0).unsqueeze(0)
                audio_fragment = tts_pipeline.vits_model.decode(
                    semantic,
                    phones,
                    refer_audio_spec,
                    speed=speed_factor,
                    sv_emb=sv_emb,
                ).detach()[0, 0, :]
                batch_audio_fragment.append(audio_fragment)
    else:
        if parallel_infer:
            batch_audio_fragment.extend(
                tts_pipeline.using_vocoder_synthesis_batched_infer(
                    idx_list,
                    pred_semantic_list,
                    batch_phones,
                    speed=speed_factor,
                    sample_steps=sample_steps,
                )
            )
        else:
            for i, idx in enumerate(idx_list):
                phones = batch_phones[i].unsqueeze(0).to(tts_pipeline.configs.device)
                semantic = pred_semantic_list[i][-idx:].unsqueeze(0).unsqueeze(0)
                audio_fragment = tts_pipeline.using_vocoder_synthesis(
                    semantic,
                    phones,
                    speed=speed_factor,
                    sample_steps=sample_steps,
                )
                batch_audio_fragment.append(audio_fragment)
    return batch_audio_fragment


def _write_direct_audio_fragment(output_path: str, audio_fragment: torch.Tensor, sample_rate: int) -> float:
    max_audio = torch.abs(audio_fragment).max()
    if float(max_audio) > 1.0:
        audio_fragment = audio_fragment / max_audio
    audio = audio_fragment.detach().cpu().numpy()
    audio = (np.clip(audio, -1.0, 1.0) * 32768.0).astype(np.int16)
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    sf.write(output_path, audio, sample_rate, subtype="PCM_16")
    return float(audio.shape[0]) / float(sample_rate or 1)


def _run_true_batch(req: dict):
    items = req.get("items") or []
    if not items:
        return {"results": []}

    check_res = _check_params({
        "text": items[0].get("text"),
        "ref_audio_path": req.get("ref_audio_path"),
        "text_lang": req.get("text_lang"),
        "prompt_lang": req.get("prompt_lang"),
        "text_split_method": req.get("text_split_method", "cut5"),
        "media_type": "wav",
    })
    if check_res is not None:
        return check_res

    tts_pipeline.stop_flag = False
    top_k = int(req.get("top_k", 15))
    top_p = float(req.get("top_p", 1))
    temperature = float(req.get("temperature", 1))
    text_lang = req.get("text_lang", "")
    text_split_method = req.get("text_split_method", "cut5")
    batch_size = int(req.get("batch_size", 20))
    batch_threshold = float(req.get("batch_threshold", 0.75))
    speed_factor = float(req.get("speed_factor", 1.0))
    split_bucket = bool(req.get("split_bucket", True))
    fragment_interval = float(req.get("fragment_interval", 0.3))
    parallel_infer = bool(req.get("parallel_infer", True))
    repetition_penalty = float(req.get("repetition_penalty", 1.35))
    sample_steps = int(req.get("sample_steps", 32))
    super_sampling = bool(req.get("super_sampling", False))
    official_fast_mode = bool(req.get("official_fast_mode", False))
    use_cuda_graph = bool(req.get("use_cuda_graph", False))
    warmup_mode = bool(req.get("warmup_mode", False))

    if parallel_infer:
        tts_pipeline.t2s_model.model.infer_panel = tts_pipeline.t2s_model.model.infer_panel_batch_infer
    else:
        tts_pipeline.t2s_model.model.infer_panel = tts_pipeline.t2s_model.model.infer_panel_naive_batched

    if speed_factor != 1.0:
        split_bucket = False
    elif tts_pipeline.configs.use_vocoder and parallel_infer:
        split_bucket = False

    _prepare_prompt_cache(req)

    flattened_data = []
    silent_results = []
    task_order = []
    task_fragment_counts: dict[int, int] = {}
    for task_position, task in enumerate(items):
        task_index = int(task["index"])
        task_order.append(task_index)
        processed = tts_pipeline.text_preprocessor.preprocess(
            str(task.get("text") or ""),
            text_lang,
            text_split_method,
            tts_pipeline.configs.version,
        )
        if len(processed) == 0:
            silent_results.append({
                "index": task_index,
                "success": False,
                "error": "Text preprocessing returned no segments",
            })
            continue
        task_fragment_counts[task_index] = len(processed)
        for fragment_index, entry in enumerate(processed):
            entry["_task_index"] = task_index
            entry["_fragment_index"] = fragment_index
            entry["_task_position"] = task_position
            flattened_data.append(entry)

    if not flattened_data:
        return {"results": silent_results}

    prompt_data = tts_pipeline.prompt_cache
    batched_data, batch_index_list = tts_pipeline.to_batch(
        flattened_data,
        prompt_data=prompt_data,
        batch_size=batch_size,
        threshold=batch_threshold,
        split_bucket=split_bucket,
        device=tts_pipeline.configs.device,
        precision=tts_pipeline.precision,
    )

    task_fragments: dict[int, list[tuple[int, torch.Tensor]]] = defaultdict(list)
    output_sr = tts_pipeline.configs.sampling_rate if not tts_pipeline.configs.use_vocoder else tts_pipeline.vocoder_configs["sr"]
    direct_output_mode = (
        official_fast_mode
        and fragment_interval <= 0.0
        and speed_factor == 1.0
        and all(int(task_fragment_counts.get(task_index, 0)) == 1 for task_index in task_order if task_index not in {int(item["index"]) for item in silent_results})
    )
    direct_results: dict[int, dict] = {}
    task_lookup = {int(task["index"]): task for task in items}

    try:
        for batch_idx, batch in enumerate(batched_data):
            bucket_fragments = _synthesize_bucket(
                batch,
                top_k=top_k,
                top_p=top_p,
                temperature=temperature,
                repetition_penalty=repetition_penalty,
                speed_factor=speed_factor,
                sample_steps=sample_steps,
                parallel_infer=parallel_infer,
                use_cuda_graph=use_cuda_graph,
            )
            index_list = batch_index_list[batch_idx]
            for original_fragment_index, audio_fragment in zip(index_list, bucket_fragments):
                fragment_meta = flattened_data[original_fragment_index]
                task_index = int(fragment_meta["_task_index"])
                if direct_output_mode:
                    task = task_lookup[task_index]
                    output_path = str(task.get("output_path") or "")
                    duration = _write_direct_audio_fragment(output_path, audio_fragment, output_sr)
                    direct_results[task_index] = {
                        "index": task_index,
                        "success": True,
                        "audio_path": output_path,
                        "duration": duration,
                    }
                    continue
                task_fragments[task_index].append((int(fragment_meta["_fragment_index"]), audio_fragment))

        results = []
        for task_index in task_order:
            if task_index in direct_results:
                results.append(direct_results[task_index])
                continue
            task = task_lookup[task_index]
            fragments = task_fragments.get(task_index)
            if not fragments:
                results.append({
                    "index": task_index,
                    "success": False,
                    "error": "No generated fragments for task",
                })
                continue
            ordered_fragments = [fragment for _, fragment in sorted(fragments, key=lambda pair: pair[0])]
            sample_rate, audio = tts_pipeline.audio_postprocess(
                [ordered_fragments],
                output_sr,
                None,
                speed_factor,
                False,
                fragment_interval,
                super_sampling if tts_pipeline.configs.use_vocoder and tts_pipeline.configs.version == "v3" else False,
            )
            output_path = str(task.get("output_path") or "")
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            sf.write(output_path, audio, sample_rate, subtype="PCM_16")
            results.append({
                "index": task_index,
                "success": True,
                "audio_path": output_path,
                "duration": float(sf.info(output_path).duration),
            })

        if silent_results:
            results.extend(silent_results)
        return {"results": results}
    finally:
        _maybe_release_gpu_memory(force=warmup_mode)


@APP.get("/control")
async def control(command: str | None = None):
    if command is None:
        return JSONResponse(status_code=400, content={"message": "command is required"})
    if command == "restart":
        os.kill(os.getpid(), signal.SIGTERM)
    if command == "exit":
        os.kill(os.getpid(), signal.SIGTERM)
    return JSONResponse(status_code=200, content={"message": "success"})


@APP.post("/tts")
async def tts_post_endpoint(request: TTSRequest):
    req = request.model_dump()
    check_res = _check_params(req)
    if check_res is not None:
        return check_res
    try:
        sample_rate, audio_data = next(tts_pipeline.run(req))
        audio_bytes = pack_wav(BytesIO(), audio_data, sample_rate).getvalue()
        return Response(audio_bytes, media_type="audio/wav")
    except Exception as exc:
        return JSONResponse(status_code=400, content={"message": "tts failed", "Exception": str(exc)})
    finally:
        _maybe_release_gpu_memory(force=bool(req.get("warmup_mode", False)))


@APP.post("/tts_batch")
async def tts_batch_endpoint(request: TTSBatchRequest):
    req = request.model_dump()
    try:
        return _run_true_batch(req)
    except Exception as exc:
        traceback.print_exc()
        return JSONResponse(status_code=400, content={"message": "tts batch failed", "Exception": str(exc)})


if __name__ == "__main__":
    try:
        if host == "None":
            host = None
        uvicorn.run(app=APP, host=host, port=port, workers=1)
    except Exception:
        traceback.print_exc()
        os.kill(os.getpid(), signal.SIGTERM)
        raise
