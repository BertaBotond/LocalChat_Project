const VALID_MESSAGE_TYPES = new Set(['text', 'code', 'emoji', 'image']);
const ROOM_NAME_PATTERN = /^[\w\- .]{2,60}$/;
const USERNAME_PATTERN = /^[\w\- .]{2,40}$/;

function normalizeString(value) {
    return (value || '').toString().trim();
}

function normalizeIdentity(value) {
    return normalizeString(value).toLowerCase();
}

function isValidRoomName(value) {
    const normalized = normalizeString(value);
    return ROOM_NAME_PATTERN.test(normalized);
}

function isValidUsername(value) {
    const normalized = normalizeString(value);
    return USERNAME_PATTERN.test(normalized);
}

function normalizeMessageType(value) {
    const normalized = normalizeString(value).toLowerCase();
    return VALID_MESSAGE_TYPES.has(normalized) ? normalized : 'text';
}

function isAllowedMimeType(value) {
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    return allowed.has((value || '').toLowerCase());
}

function clampMessageContentByType(content, messageType) {
    const raw = normalizeString(content);

    if (messageType === 'emoji') {
        return raw.slice(0, 32);
    }

    if (messageType === 'code') {
        return raw.slice(0, 8000);
    }

    return raw.slice(0, 2000);
}

function isSafeRoomId(value) {
    const roomId = Number(value);
    return Number.isFinite(roomId) && roomId >= 1;
}

module.exports = {
    normalizeString,
    normalizeIdentity,
    isValidRoomName,
    isValidUsername,
    normalizeMessageType,
    isAllowedMimeType,
    clampMessageContentByType,
    isSafeRoomId
};
