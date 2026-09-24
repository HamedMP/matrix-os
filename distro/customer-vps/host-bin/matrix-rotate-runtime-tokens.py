#!/usr/bin/python3 -I
"""Root-only, encrypted, per-machine host token activation."""
import base64
import hashlib
import json
import os
import re
import stat
import sys
import tempfile

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ENV_PATH = '/opt/matrix/env/host.env'
KEY_PATH = '/opt/matrix/env/runtime-token-rotation.pem'
TOKEN_KEYS = {
    'sync': 'MATRIX_SYNC_RUNTIME_TOKEN',
    'fundedAi': 'MATRIX_FUNDED_AI_RUNTIME_TOKEN',
    'speech': 'MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN',
}


def read_regular(path, maximum, root_only=False):
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_size > maximum or info.st_mode & 0o022:
        raise ValueError('Unsafe rotation file')
    if root_only and (info.st_mode & 0o077 or (os.geteuid() == 0 and info.st_uid != 0)):
        raise ValueError('Unsafe rotation key')
    with open(path, 'rb') as file:
        value = file.read(maximum + 1)
    if len(value) > maximum:
        raise ValueError('Unsafe rotation file')
    return value


def decode(value):
    if not isinstance(value, str) or len(value) > 8192 or not re.fullmatch(r'[A-Za-z0-9+/]+={0,2}', value):
        raise ValueError('Invalid rotation envelope')
    return base64.b64decode(value, validate=True)


def one_value(lines, key):
    values = [line[len(key) + 1:] for line in lines if line.startswith(key + '=')]
    if len(values) != 1:
        raise ValueError('Invalid host environment')
    return values[0]


def host_verifier_digest(env_path):
    lines = read_regular(env_path, 65536).decode('utf-8').split('\n')
    return hashlib.sha256(one_value(lines, 'UPGRADE_TOKEN').encode('utf-8')).hexdigest()


def apply_rotation(env_path, key_path, envelope_path):
    env_bytes = read_regular(env_path, 65536)
    private_key = serialization.load_pem_private_key(read_regular(key_path, 8192, True), password=None)
    envelope = json.loads(read_regular(envelope_path, 65536))
    if not isinstance(envelope, dict) or set(envelope) != {'version', 'encryptedKey', 'nonce', 'ciphertext', 'tag'} or envelope['version'] != 1:
        raise ValueError('Invalid rotation envelope')
    key = private_key.decrypt(decode(envelope['encryptedKey']), padding.OAEP(
        mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None,
    ))
    nonce = decode(envelope['nonce'])
    tag = decode(envelope['tag'])
    if len(key) != 32 or len(nonce) != 12 or len(tag) != 16:
        raise ValueError('Invalid rotation envelope')
    payload = json.loads(AESGCM(key).decrypt(nonce, decode(envelope['ciphertext']) + tag, None))
    tokens = payload.get('tokens') if isinstance(payload, dict) else None
    if (not isinstance(payload, dict) or not isinstance(payload.get('machineId'), str) or
            not isinstance(payload.get('runtimeSlot'), str) or
            not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', payload['machineId']) or
            not re.fullmatch(r'[a-z0-9-]{1,32}', payload['runtimeSlot']) or
            type(payload.get('epoch')) is not int or not 2 <= payload['epoch'] <= 2147483647 or
            not isinstance(tokens, dict) or set(tokens) != set(TOKEN_KEYS) or
            any(not isinstance(token, str) or not re.fullmatch(r'[a-f0-9]{64}', token) for token in tokens.values())):
        raise ValueError('Invalid rotation payload')

    lines = env_bytes.decode('utf-8').split('\n')
    if (one_value(lines, 'MATRIX_MACHINE_ID') != payload['machineId'] or
            one_value(lines, 'MATRIX_RUNTIME_SLOT') != payload['runtimeSlot']):
        raise ValueError('Rotation target does not match this host')
    epochs = [line for line in lines if line.startswith('MATRIX_RUNTIME_TOKEN_EPOCH=')]
    if len(epochs) > 1:
        raise ValueError('Invalid host environment')
    current_epoch = int(epochs[0].split('=', 1)[1]) if epochs else 1
    if payload['epoch'] != current_epoch + 1:
        raise ValueError('Unexpected runtime token epoch')
    for key_name in TOKEN_KEYS.values():
        one_value(lines, key_name)
    replacements = {key_name: tokens[field] for field, key_name in TOKEN_KEYS.items()}
    replacements['MATRIX_RUNTIME_TOKEN_EPOCH'] = str(payload['epoch'])
    next_lines = [line.split('=', 1)[0] + '=' + replacements[line.split('=', 1)[0]]
                  if line.split('=', 1)[0] in replacements else line for line in lines]
    if not epochs:
        next_lines.insert(-1 if next_lines[-1] == '' else len(next_lines),
                          'MATRIX_RUNTIME_TOKEN_EPOCH=' + str(payload['epoch']))

    original = os.lstat(env_path)
    directory = os.path.dirname(os.path.abspath(env_path))
    descriptor, temporary = tempfile.mkstemp(prefix='.host.env.rotation-', dir=directory)
    try:
        with os.fdopen(descriptor, 'wb') as file:
            os.fchmod(file.fileno(), stat.S_IMODE(original.st_mode))
            os.fchown(file.fileno(), original.st_uid, original.st_gid)
            file.write('\n'.join(next_lines).encode('utf-8'))
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, env_path)
        directory_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return payload['epoch']


def main():
    if os.geteuid() != 0:
        raise ValueError('Root is required')
    if len(sys.argv) == 2 and sys.argv[1] == 'init':
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        private_pem = private_key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        descriptor = os.open(KEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as file:
            file.write(private_pem)
            file.flush()
            os.fsync(file.fileno())
        sys.stdout.buffer.write(private_key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
        ))
        return
    if len(sys.argv) == 2 and sys.argv[1] == 'public-key':
        private_key = serialization.load_pem_private_key(read_regular(KEY_PATH, 8192, True), password=None)
        sys.stdout.buffer.write(private_key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
        ))
        return
    if len(sys.argv) == 2 and sys.argv[1] == 'verifier-digest':
        print(host_verifier_digest(ENV_PATH))
        return
    if len(sys.argv) == 3 and sys.argv[1] == 'apply':
        epoch = apply_rotation(ENV_PATH, KEY_PATH, sys.argv[2])
        print(f'Runtime token epoch {epoch} installed. Restart dependent services.')
        return
    raise ValueError('Usage: matrix-rotate-runtime-tokens.py <init|public-key|verifier-digest|apply ENCRYPTED_FILE>')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Runtime token rotation failed.', file=sys.stderr)
        sys.exit(1)
