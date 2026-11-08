"""Versioned, lossless SQLite payload encoding; legacy JSON stays readable."""
import json
import zlib

MAGIC = b'AHZ1'
MAX_RECORD = 64 * 1024 * 1024


def pack_text(text):
    raw = text.encode('utf-8')
    # Keep unusually large records in their legacy representation, rather than
    # creating compressed records that our bounded reader cannot open.
    if len(raw) > MAX_RECORD:
        return text
    candidate = MAGIC + zlib.compress(raw, 6)
    return candidate if len(candidate) + 32 < len(raw) else text


def unpack_text(value):
    if isinstance(value, str):
        return value
    if not isinstance(value, bytes) or not value.startswith(MAGIC):
        raise ValueError('保管記録の形式を認識できません。')
    try:
        stream = zlib.decompressobj()
        raw = stream.decompress(value[len(MAGIC):], MAX_RECORD + 1)
        if len(raw) > MAX_RECORD or not stream.eof or stream.unused_data:
            raise ValueError('保管記録の圧縮データが壊れています。')
        return raw.decode('utf-8')
    except (zlib.error, UnicodeError) as error:
        raise ValueError('保管記録の圧縮データが壊れています。') from error


def dumps(record):
    return pack_text(json.dumps(record, ensure_ascii=False))


def loads(value):
    return json.loads(unpack_text(value))
