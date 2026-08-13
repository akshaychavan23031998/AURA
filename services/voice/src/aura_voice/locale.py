import re
import unicodedata
from dataclasses import dataclass
from typing import Literal

CanonicalLanguage = Literal["en", "hi", "te", "kn"]
SpeechStyle = Literal["native", "latin-mixed"]
_LATIN = re.compile(r"[A-Za-z]")


class UnsupportedLocaleError(Exception):
    pass


@dataclass(frozen=True)
class SynthesisLocale:
    language: CanonicalLanguage
    locale: str
    style: SpeechStyle


def normalize_locale(value: str, text: str) -> SynthesisLocale:
    normalized = value.strip().replace("_", "-").lower()
    language = normalized.split("-", 1)[0]
    canonical: dict[str, tuple[CanonicalLanguage, str]] = {
        "en": ("en", "en-IN" if normalized == "en-in" else "en-US"),
        "hi": ("hi", "hi-IN"),
        "te": ("te", "te-IN"),
        "kn": ("kn", "kn-IN"),
    }
    selected = canonical.get(language)
    if selected is None:
        raise UnsupportedLocaleError
    style: SpeechStyle = (
        "latin-mixed" if language == "hi" and _LATIN.search(text) else "native"
    )
    return SynthesisLocale(selected[0], selected[1], style)


def normalize_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).split())
