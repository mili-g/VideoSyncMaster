import pathlib
import sys
import unittest


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "services" / "media_pipeline"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from vsm.domain.workflow import DubSegment, ProcessingSession, SessionArtifact, SubtitleSegment, TranslatedSegment


class WorkflowEntityTests(unittest.TestCase):
    def test_subtitle_segment_validation_and_duration(self) -> None:
        segment = SubtitleSegment(index=1, start=1.25, end=3.75, text="hello")

        segment.validate()

        self.assertEqual(2.5, segment.duration)
        self.assertEqual("hello", segment.to_payload()["text"])

    def test_translated_segment_uses_duration_budget_fallback(self) -> None:
        segment = TranslatedSegment(
            index=0,
            start=0.0,
            end=2.0,
            text="source",
            translated_text="target",
            target_language="en",
        )

        payload = segment.to_payload()

        self.assertTrue(segment.is_readable())
        self.assertEqual(2.0, payload["duration_budget"])

    def test_dub_segment_retry_semantics(self) -> None:
        failed = DubSegment(index=2, status="error", error_info={"code": "TTS_FAILED"})
        ready = DubSegment(index=2, status="ready", audio_path="segment_2.wav")

        self.assertTrue(failed.can_retry())
        self.assertTrue(ready.is_ready())

    def test_processing_session_adds_artifact_immutably(self) -> None:
        session = ProcessingSession(session_key="s1", phase="dubbing", current_stage="batch")
        artifact = SessionArtifact(kind="audio", path="audio/segment_1.wav")

        next_session = session.add_artifact(artifact)
        failed_session = next_session.mark_failed({"code": "MERGE_FAILED"})

        self.assertEqual(0, len(session.artifacts))
        self.assertEqual(1, len(next_session.artifacts))
        self.assertEqual("failed", failed_session.phase)
        self.assertEqual("MERGE_FAILED", failed_session.last_error["code"])


if __name__ == "__main__":
    unittest.main()
