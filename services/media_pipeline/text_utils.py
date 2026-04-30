import re

_NO_SPACE_LANGUAGES = r"[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u0e00-\u0eff\u1000-\u109f\u1780-\u17ff\u0900-\u0dff]"
_SPACE_SEPARATED_LANGUAGES = (
    r"^[a-zA-Z0-9'\u0400-\u04ff\u0370-\u03ff\u0600-\u06ff\u0590-\u05ff\u0e00-\u0e7f]+$"
)


def is_pure_punctuation(text: str) -> bool:
    return not re.search(r"\w", text, re.UNICODE)


def is_mainly_cjk(text: str, threshold: float = 0.5) -> bool:
    if not text:
        return False

    no_space_count = len(re.findall(_NO_SPACE_LANGUAGES, text))
    total_chars = len("".join(text.split()))
    return no_space_count / total_chars > threshold if total_chars > 0 else False


def is_space_separated_language(text: str) -> bool:
    if not text:
        return False
    return bool(re.match(_SPACE_SEPARATED_LANGUAGES, text.strip()))


def count_words(text: str) -> int:
    if not text:
        return 0

    char_count = len(re.findall(_NO_SPACE_LANGUAGES, text))
    word_text = re.sub(_NO_SPACE_LANGUAGES, " ", text)
    word_count = len(word_text.strip().split())
    return char_count + word_count
