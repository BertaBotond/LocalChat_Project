CREATE DATABASE IF NOT EXISTS `localchat`;
USE `localchat`;

CREATE TABLE IF NOT EXISTS rooms (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    is_private TINYINT(1) NOT NULL DEFAULT 0,
    owner_username VARCHAR(50) NULL,
    invite_code VARCHAR(32) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_rooms_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS messages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    room_id INT UNSIGNED NOT NULL,
    username VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    ip_optional VARCHAR(45) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_messages_room_created (room_id, created_at),
    CONSTRAINT fk_messages_room FOREIGN KEY (room_id)
        REFERENCES rooms (id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS host_status (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    ip VARCHAR(45) NOT NULL,
    status ENUM('online', 'offline', 'unknown') NOT NULL DEFAULT 'unknown',
    last_seen_at TIMESTAMP NULL,
    last_checked_at TIMESTAMP NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_host_status_ip (ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS connections_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    socket_id VARCHAR(120) NOT NULL,
    username VARCHAR(50) NOT NULL,
    client_ip VARCHAR(45) NULL,
    connected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    disconnected_at TIMESTAMP NULL,
    PRIMARY KEY (id),
    KEY idx_connections_connected_at (connected_at),
    KEY idx_connections_socket_id (socket_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS room_members (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    room_id INT UNSIGNED NOT NULL,
    username VARCHAR(50) NOT NULL,
    added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_room_member (room_id, username),
    KEY idx_room_members_room (room_id),
    KEY idx_room_members_username (username),
    CONSTRAINT fk_room_members_room FOREIGN KEY (room_id)
        REFERENCES rooms (id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO rooms (id, name, is_private) VALUES (1, 'general', 0);
