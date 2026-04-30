from __future__ import annotations

import warnings

from indextts.infer_v2 import IndexTTS2


class IndexTTS(IndexTTS2):
    """
    Backward-compatible adapter for legacy callers that still import
    ``indextts.infer.IndexTTS`` and pass ``audio_prompt=...``.
    """

    def infer(
        self,
        audio_prompt,
        text,
        output_path,
        verbose: bool = False,
        max_text_tokens_per_segment: int = 120,
        **generation_kwargs,
    ):
        warnings.warn(
            "indextts.infer.IndexTTS is deprecated; use indextts.infer_v2.IndexTTS2 instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        return super().infer(
            spk_audio_prompt=audio_prompt,
            text=text,
            output_path=output_path,
            verbose=verbose,
            max_text_tokens_per_segment=max_text_tokens_per_segment,
            **generation_kwargs,
        )

