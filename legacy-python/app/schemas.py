from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ImageSpec(StrictModel):
    prompt: str = Field(min_length=1, max_length=1600)
    negative_prompt: str = Field(default="", max_length=350)


class AudioSpec(StrictModel):
    transcript: str = Field(min_length=1, max_length=1000)
    description: str = Field(default="Clear, natural English pronunciation.", max_length=500)


class Element(StrictModel):
    text: str = Field(min_length=1, max_length=2000)
    image: ImageSpec | None = None
    audio: AudioSpec | None = None


class Option(Element):
    is_correct: bool


class Pair(StrictModel):
    left: Element
    right: Element


class BaseQuestion(StrictModel):
    instruction_text: str = Field(default="", max_length=1000)
    hint: str = Field(default="", max_length=2000)
    explanation: str = Field(default="", max_length=4000)


class Completion(BaseQuestion):
    question_type: Literal["COMP_SEL"]
    stem: Element
    options: list[Option] = Field(min_length=4, max_length=8)

    @model_validator(mode="after")
    def valid(self):
        if self.stem.text.count("___") != 1:
            raise ValueError("Stem must contain exactly one ___ blank")
        if sum(o.is_correct for o in self.options) != 1:
            raise ValueError("Exactly one correct option required")
        if len({o.text.casefold() for o in self.options}) != len(self.options):
            raise ValueError("Duplicate options")
        return self


class Typing(BaseQuestion):
    question_type: Literal["TYPING"]
    stem: Element
    answer: Element
    completed_sentence: str = Field(min_length=1, max_length=2000)
    case_sensitive: bool = False

    @model_validator(mode="after")
    def valid(self):
        if self.stem.text.count("___") != 1:
            raise ValueError("Stem must contain exactly one ___ blank")
        if self.stem.text.replace("___", self.answer.text) != self.completed_sentence:
            raise ValueError("Completed sentence does not match the blank answer")
        if self.answer.image:
            raise ValueError("Typing answer is text, not an image")
        return self


class Matching(BaseQuestion):
    question_type: Literal["MATCH"]
    pairs: list[Pair] = Field(min_length=2, max_length=8)

    @model_validator(mode="after")
    def valid(self):
        for side in ("left", "right"):
            values = [getattr(p, side).text.casefold() for p in self.pairs]
            if len(set(values)) != len(values):
                raise ValueError("Matching sides must be distinct")
        return self


class Ordering(BaseQuestion):
    question_type: Literal["ORDER"]
    tokens: list[Element] = Field(min_length=2, max_length=10)
    answer: Element

    @model_validator(mode="after")
    def valid(self):
        if " ".join(t.text for t in self.tokens) != self.answer.text:
            raise ValueError("Ordered tokens must join exactly to the answer")
        if len(self.answer.text.split()) > 10:
            raise ValueError("Ordering supports at most 10 words")
        if any(t.image for t in self.tokens) or self.answer.image:
            raise ValueError("Ordering uses text chunks")
        return self


class Listening(BaseQuestion):
    question_type: Literal["LISTEN"]
    items: list[Element] = Field(min_length=2, max_length=8)

    @model_validator(mode="after")
    def valid(self):
        if any(not i.image or not i.audio for i in self.items):
            raise ValueError("Every listening item requires its own image and audio")
        if len({i.text.casefold() for i in self.items}) != len(self.items):
            raise ValueError("Listening images must be distinguishable")
        return self


QuestionDraft = Annotated[
    Completion | Typing | Matching | Ordering | Listening, Field(discriminator="question_type")
]


class DraftBatch(StrictModel):
    questions: list[QuestionDraft] = Field(min_length=1, max_length=10)


class GenerationRequest(StrictModel):
    request_key: UUID
    lo_id: UUID
    question_type: Literal["COMP_SEL", "TYPING", "MATCH", "ORDER", "LISTEN"]
    bloom_level: int = Field(ge=1, le=4)
    count: int = Field(default=1, ge=1, le=10)
    include_images: bool = False
    include_audio: bool = False
    instructions: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def media_rules(self):
        if self.question_type == "LISTEN" and not (self.include_audio and self.include_images):
            raise ValueError("LISTEN requires both images and separate audio clips")
        if self.question_type == "ORDER" and self.include_images:
            raise ValueError("ORDER is text/audio only in this POC")
        return self


def elements(q: QuestionDraft) -> list[Element]:
    if isinstance(q, Completion):
        return [q.stem, *q.options]
    if isinstance(q, Typing):
        return [q.stem, q.answer]
    if isinstance(q, Matching):
        return [e for p in q.pairs for e in (p.left, p.right)]
    if isinstance(q, Ordering):
        return [*q.tokens, q.answer]
    return list(q.items)


def answer_elements(q: QuestionDraft) -> list[Element]:
    if isinstance(q, Completion):
        return list(q.options)
    if isinstance(q, Typing):
        return [q.answer]
    if isinstance(q, Matching):
        return elements(q)
    if isinstance(q, Ordering):
        return [*q.tokens, q.answer]
    return list(q.items)


def validate_batch(batch: DraftBatch, request: GenerationRequest) -> None:
    if len(batch.questions) != request.count:
        raise ValueError("Generated question count differs from request")
    seen = set()
    for q in batch.questions:
        if q.question_type != request.question_type:
            raise ValueError("Generated question type differs from request")
        fingerprint = q.model_dump_json()
        if fingerprint in seen:
            raise ValueError("Exact duplicate question in generated batch")
        seen.add(fingerprint)
        if not request.include_images and any(e.image for e in elements(q)):
            raise ValueError("Unrequested image generation")
        if request.include_images and not any(e.image for e in elements(q)):
            raise ValueError("Missing requested image")
        if not request.include_audio and any(e.audio for e in elements(q)):
            raise ValueError("Unrequested audio generation")
        if request.include_audio and any(not e.audio for e in answer_elements(q)):
            raise ValueError("Every answer/item requires a separate audio spec")
