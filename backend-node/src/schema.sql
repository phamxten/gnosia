CREATE TABLE `organizations` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`name` VARCHAR(160) NOT NULL,
	PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `paths` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`slug` VARCHAR(60) NOT NULL,
	`title` VARCHAR(120) NOT NULL,
	`description` MEDIUMTEXT NOT NULL,
	PRIMARY KEY (`id`),
	UNIQUE (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `classes` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`org_id` INT NOT NULL,
	`name` VARCHAR(80) NOT NULL,
	`path_id` INT,
	`mentor_id` INT,
	`started_on` DATE,
	PRIMARY KEY (`id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`),
	FOREIGN KEY (`path_id`) REFERENCES `paths` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `projects` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`path_id` INT NOT NULL,
	`slug` VARCHAR(60) NOT NULL,
	`title` VARCHAR(120) NOT NULL,
	`number` INT NOT NULL,
	`unlock_after` INT NOT NULL,
	`description` MEDIUMTEXT NOT NULL,
	`milestones` JSON NOT NULL,
	PRIMARY KEY (`id`),
	FOREIGN KEY (`path_id`) REFERENCES `paths` (`id`),
	UNIQUE (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `users` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`email` VARCHAR(200) NOT NULL,
	`name` VARCHAR(120) NOT NULL,
	`password_hash` VARCHAR(200) NOT NULL,
	`role` VARCHAR(16) NOT NULL,
	`org_id` INT,
	`class_id` INT,
	`avatar` VARCHAR(4) NOT NULL,
	`title` VARCHAR(120) NOT NULL,
	`onboarded` TINYINT(1) NOT NULL,
	`goal` VARCHAR(40) NOT NULL,
	`daily_goal_min` INT NOT NULL,
	`assist_cap` INT NOT NULL,
	`prefs` JSON NOT NULL,
	`created_at` DATETIME(3) NOT NULL,
	`last_active_at` DATETIME(3),
	PRIMARY KEY (`id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations` (`id`),
	FOREIGN KEY (`class_id`) REFERENCES `classes` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `ix_users_email` ON `users` (`email`);

CREATE TABLE `chapters` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`path_id` INT NOT NULL,
	`position` INT NOT NULL,
	`number` INT NOT NULL,
	`kind` VARCHAR(16) NOT NULL,
	`slug` VARCHAR(60) NOT NULL,
	`title` VARCHAR(120) NOT NULL,
	`subtitle` VARCHAR(160) NOT NULL,
	`description` MEDIUMTEXT NOT NULL,
	`icon` VARCHAR(40) NOT NULL,
	`module_label` VARCHAR(80) NOT NULL,
	`map_x` INT NOT NULL,
	`project_id` INT,
	`status` VARCHAR(16) NOT NULL,
	`version` INT NOT NULL,
	`draft` JSON NOT NULL,
	`draft_saved_at` DATETIME(3),
	`updated_at` DATETIME(3) NOT NULL,
	`updated_by` INT,
	PRIMARY KEY (`id`),
	UNIQUE (`path_id`, `slug`),
	FOREIGN KEY (`path_id`) REFERENCES `paths` (`id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`),
	FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mastery_snapshots` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`user_id` INT NOT NULL,
	`week_start` DATE NOT NULL,
	`pct` INT NOT NULL,
	PRIMARY KEY (`id`),
	UNIQUE (`user_id`, `week_start`),
	FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `ix_mastery_snapshots_user_id` ON `mastery_snapshots` (`user_id`);

CREATE TABLE `xp_events` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`user_id` INT NOT NULL,
	`amount` INT NOT NULL,
	`reason` VARCHAR(80) NOT NULL,
	`created_at` DATETIME(3) NOT NULL,
	PRIMARY KEY (`id`),
	FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `ix_xp_events_created_at` ON `xp_events` (`created_at`);

CREATE INDEX `ix_xp_events_user_id` ON `xp_events` (`user_id`);

CREATE TABLE `daily_activity` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`user_id` INT NOT NULL,
	`day` DATE NOT NULL,
	`seconds` INT NOT NULL,
	PRIMARY KEY (`id`),
	UNIQUE (`user_id`, `day`),
	FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `ix_daily_activity_user_id` ON `daily_activity` (`user_id`);

CREATE TABLE `project_progress` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`user_id` INT NOT NULL,
	`project_id` INT NOT NULL,
	`milestone` INT NOT NULL,
	`code` MEDIUMTEXT NOT NULL,
	`status` VARCHAR(12) NOT NULL,
	`last_run` JSON,
	`published_at` DATETIME(3),
	`updated_at` DATETIME(3) NOT NULL,
	PRIMARY KEY (`id`),
	UNIQUE (`user_id`, `project_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
	FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `ix_project_progress_user_id` ON `project_progress` (`user_id`);

CREATE TABLE `messages` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`learner_id` INT NOT NULL,
	`author_id` INT NOT NULL,
	`project_id` INT,
	`context` VARCHAR(160) NOT NULL,
	`body` MEDIUMTEXT NOT NULL,
	`read` TINYINT(1) NOT NULL,
	`created_at` DATETIME(3) NOT NULL,
	PRIMARY KEY (`id`),
	FOREIGN KEY (`learner_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
	FOREIGN KEY (`author_id`) REFERENCES `users` (`id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `ix_messages_learner_id` ON `messages` (`learner_id`);

CREATE TABLE `notifications` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`user_id` INT NOT NULL,
	`kind` VARCHAR(24) NOT NULL,
	`title` VARCHAR(200) NOT NULL,
	`body` MEDIUMTEXT NOT NULL,
	`link` VARCHAR(200) NOT NULL,
	`read` TINYINT(1) NOT NULL,
	`created_at` DATETIME(3) NOT NULL,
	PRIMARY KEY (`id`),
	FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `ix_notifications_user_id` ON `notifications` (`user_id`);

CREATE TABLE `chapter_versions` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`chapter_id` INT NOT NULL,
	`version` INT NOT NULL,
	`content` JSON NOT NULL,
	`published_at` DATETIME(3) NOT NULL,
	`published_by` INT,
	PRIMARY KEY (`id`),
	UNIQUE (`chapter_id`, `version`),
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters` (`id`) ON DELETE CASCADE,
	FOREIGN KEY (`published_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `ix_chapter_versions_chapter_id` ON `chapter_versions` (`chapter_id`);

CREATE TABLE `concepts` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`path_id` INT NOT NULL,
	`key` VARCHAR(60) NOT NULL,
	`name` VARCHAR(80) NOT NULL,
	`skill` VARCHAR(120) NOT NULL,
	`chapter_id` INT,
	`x` INT NOT NULL,
	`y` INT NOT NULL,
	`requires` JSON NOT NULL,
	PRIMARY KEY (`id`),
	UNIQUE (`path_id`, `key`),
	FOREIGN KEY (`path_id`) REFERENCES `paths` (`id`),
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `chapter_progress` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`user_id` INT NOT NULL,
	`chapter_id` INT NOT NULL,
	`version` INT NOT NULL,
	`phases` JSON NOT NULL,
	`current` VARCHAR(12) NOT NULL,
	`started_at` DATETIME(3) NOT NULL,
	`updated_at` DATETIME(3) NOT NULL,
	`completed_at` DATETIME(3),
	`phase_since` DATETIME(3) NOT NULL,
	`active_seconds` INT NOT NULL,
	PRIMARY KEY (`id`),
	UNIQUE (`user_id`, `chapter_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `ix_chapter_progress_user_id` ON `chapter_progress` (`user_id`);

CREATE TABLE `player_states` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`user_id` INT NOT NULL,
	`chapter_id` INT NOT NULL,
	`phase` VARCHAR(16) NOT NULL,
	`data` JSON NOT NULL,
	`updated_at` DATETIME(3) NOT NULL,
	PRIMARY KEY (`id`),
	UNIQUE (`user_id`, `chapter_id`, `phase`),
	FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `ix_player_states_user_id` ON `player_states` (`user_id`);

CREATE TABLE `attempts` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`user_id` INT NOT NULL,
	`chapter_id` INT NOT NULL,
	`phase` VARCHAR(12) NOT NULL,
	`item_id` VARCHAR(40) NOT NULL,
	`attempt_no` INT NOT NULL,
	`correct` TINYINT(1) NOT NULL,
	`answer` JSON,
	`hint_level` INT NOT NULL,
	`ms` INT NOT NULL,
	`version` INT NOT NULL,
	`created_at` DATETIME(3) NOT NULL,
	PRIMARY KEY (`id`),
	FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `ix_attempts_created_at` ON `attempts` (`created_at`);

CREATE INDEX `ix_attempts_user_id` ON `attempts` (`user_id`);

CREATE INDEX `ix_attempts_chapter_id` ON `attempts` (`chapter_id`);

CREATE TABLE `hint_opens` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`user_id` INT NOT NULL,
	`chapter_id` INT NOT NULL,
	`item_id` VARCHAR(40) NOT NULL,
	`level` INT NOT NULL,
	`ms_since_shown` INT NOT NULL,
	`created_at` DATETIME(3) NOT NULL,
	PRIMARY KEY (`id`),
	FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `ix_hint_opens_user_id` ON `hint_opens` (`user_id`);

CREATE TABLE `quiz_rounds` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`user_id` INT NOT NULL,
	`chapter_id` INT,
	`kind` VARCHAR(12) NOT NULL,
	`version` INT NOT NULL,
	`question_refs` JSON NOT NULL,
	`answers` JSON NOT NULL,
	`per_question_sec` INT NOT NULL,
	`score` INT NOT NULL,
	`combo` INT NOT NULL,
	`best_combo` INT NOT NULL,
	`finished` TINYINT(1) NOT NULL,
	`pct` INT,
	`passed` TINYINT(1),
	`created_at` DATETIME(3) NOT NULL,
	PRIMARY KEY (`id`),
	FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `ix_quiz_rounds_user_id` ON `quiz_rounds` (`user_id`);

CREATE TABLE `exam_sessions` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`user_id` INT NOT NULL,
	`chapter_id` INT NOT NULL,
	`version` INT NOT NULL,
	`started_at` DATETIME(3) NOT NULL,
	`deadline` DATETIME(3) NOT NULL,
	`answers` JSON NOT NULL,
	`flags` JSON NOT NULL,
	`submitted_at` DATETIME(3),
	`score` INT,
	`passed` TINYINT(1),
	`results` JSON,
	PRIMARY KEY (`id`),
	FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `ix_exam_sessions_user_id` ON `exam_sessions` (`user_id`);

CREATE TABLE `submissions` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`user_id` INT NOT NULL,
	`kind` VARCHAR(12) NOT NULL,
	`chapter_id` INT,
	`project_id` INT,
	`milestone` INT,
	`title` VARCHAR(160) NOT NULL,
	`filename` VARCHAR(80) NOT NULL,
	`code` MEDIUMTEXT NOT NULL,
	`attempt_no` INT NOT NULL,
	`tests_passed` INT NOT NULL,
	`tests_total` INT NOT NULL,
	`error_line` INT,
	`status` VARCHAR(12) NOT NULL,
	`summary` MEDIUMTEXT NOT NULL,
	`reviewed_by` INT,
	`reviewed_at` DATETIME(3),
	`seen_by_learner` TINYINT(1) NOT NULL,
	`created_at` DATETIME(3) NOT NULL,
	PRIMARY KEY (`id`),
	FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters` (`id`) ON DELETE CASCADE,
	FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE CASCADE,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `ix_submissions_user_id` ON `submissions` (`user_id`);

CREATE TABLE `notebooks` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`user_id` INT NOT NULL,
	`title` VARCHAR(160) NOT NULL,
	`attached_chapter_id` INT,
	`cells` JSON NOT NULL,
	`created_at` DATETIME(3) NOT NULL,
	`updated_at` DATETIME(3) NOT NULL,
	PRIMARY KEY (`id`),
	FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
	FOREIGN KEY (`attached_chapter_id`) REFERENCES `chapters` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `ix_notebooks_user_id` ON `notebooks` (`user_id`);

CREATE TABLE `assignments` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`mentor_id` INT NOT NULL,
	`learner_id` INT NOT NULL,
	`chapter_id` INT,
	`title` VARCHAR(200) NOT NULL,
	`link` VARCHAR(200) NOT NULL,
	`done` TINYINT(1) NOT NULL,
	`created_at` DATETIME(3) NOT NULL,
	PRIMARY KEY (`id`),
	FOREIGN KEY (`mentor_id`) REFERENCES `users` (`id`),
	FOREIGN KEY (`learner_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `ix_assignments_learner_id` ON `assignments` (`learner_id`);

CREATE TABLE `content_reports` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`user_id` INT NOT NULL,
	`chapter_id` INT NOT NULL,
	`item_id` VARCHAR(40) NOT NULL,
	`body` MEDIUMTEXT NOT NULL,
	`created_at` DATETIME(3) NOT NULL,
	PRIMARY KEY (`id`),
	FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `concept_mastery` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`user_id` INT NOT NULL,
	`concept_id` INT NOT NULL,
	`tier` INT NOT NULL,
	`weak` TINYINT(1) NOT NULL,
	`weak_phase` VARCHAR(12) NOT NULL,
	`weak_note` MEDIUMTEXT NOT NULL,
	`last_evidence` VARCHAR(200) NOT NULL,
	`updated_at` DATETIME(3) NOT NULL,
	PRIMARY KEY (`id`),
	UNIQUE (`user_id`, `concept_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `ix_concept_mastery_user_id` ON `concept_mastery` (`user_id`);

CREATE TABLE `review_comments` (
	`id` INT NOT NULL AUTO_INCREMENT,
	`submission_id` INT NOT NULL,
	`author_id` INT NOT NULL,
	`line` INT NOT NULL,
	`body` MEDIUMTEXT NOT NULL,
	`created_at` DATETIME(3) NOT NULL,
	PRIMARY KEY (`id`),
	FOREIGN KEY (`submission_id`) REFERENCES `submissions` (`id`) ON DELETE CASCADE,
	FOREIGN KEY (`author_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `ix_review_comments_submission_id` ON `review_comments` (`submission_id`);

ALTER TABLE `classes` ADD FOREIGN KEY (`mentor_id`) REFERENCES `users` (`id`);
