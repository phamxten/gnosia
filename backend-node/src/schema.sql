CREATE TABLE organizations (
	id SERIAL NOT NULL, 
	name VARCHAR(160) NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE paths (
	id SERIAL NOT NULL, 
	slug VARCHAR(60) NOT NULL, 
	title VARCHAR(120) NOT NULL, 
	description TEXT NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (slug)
);

CREATE TABLE classes (
	id SERIAL NOT NULL, 
	org_id INTEGER NOT NULL, 
	name VARCHAR(80) NOT NULL, 
	path_id INTEGER, 
	mentor_id INTEGER, 
	started_on DATE, 
	PRIMARY KEY (id), 
	FOREIGN KEY(org_id) REFERENCES organizations (id), 
	FOREIGN KEY(path_id) REFERENCES paths (id)
);

CREATE TABLE projects (
	id SERIAL NOT NULL, 
	path_id INTEGER NOT NULL, 
	slug VARCHAR(60) NOT NULL, 
	title VARCHAR(120) NOT NULL, 
	number INTEGER NOT NULL, 
	unlock_after INTEGER NOT NULL, 
	description TEXT NOT NULL, 
	milestones JSON NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(path_id) REFERENCES paths (id), 
	UNIQUE (slug)
);

CREATE TABLE users (
	id SERIAL NOT NULL, 
	email VARCHAR(200) NOT NULL, 
	name VARCHAR(120) NOT NULL, 
	password_hash VARCHAR(200) NOT NULL, 
	role VARCHAR(16) NOT NULL, 
	org_id INTEGER, 
	class_id INTEGER, 
	avatar VARCHAR(4) NOT NULL, 
	title VARCHAR(120) NOT NULL, 
	onboarded BOOLEAN NOT NULL, 
	goal VARCHAR(40) NOT NULL, 
	daily_goal_min INTEGER NOT NULL, 
	assist_cap INTEGER NOT NULL, 
	prefs JSON NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	last_active_at TIMESTAMP WITHOUT TIME ZONE, 
	PRIMARY KEY (id), 
	FOREIGN KEY(org_id) REFERENCES organizations (id), 
	FOREIGN KEY(class_id) REFERENCES classes (id)
);

CREATE UNIQUE INDEX ix_users_email ON users (email);

CREATE TABLE chapters (
	id SERIAL NOT NULL, 
	path_id INTEGER NOT NULL, 
	position INTEGER NOT NULL, 
	number INTEGER NOT NULL, 
	kind VARCHAR(16) NOT NULL, 
	slug VARCHAR(60) NOT NULL, 
	title VARCHAR(120) NOT NULL, 
	subtitle VARCHAR(160) NOT NULL, 
	description TEXT NOT NULL, 
	icon VARCHAR(40) NOT NULL, 
	module_label VARCHAR(80) NOT NULL, 
	map_x INTEGER NOT NULL, 
	project_id INTEGER, 
	status VARCHAR(16) NOT NULL, 
	version INTEGER NOT NULL, 
	draft JSON NOT NULL, 
	draft_saved_at TIMESTAMP WITHOUT TIME ZONE, 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	updated_by INTEGER, 
	PRIMARY KEY (id), 
	UNIQUE (path_id, slug), 
	FOREIGN KEY(path_id) REFERENCES paths (id), 
	FOREIGN KEY(project_id) REFERENCES projects (id), 
	FOREIGN KEY(updated_by) REFERENCES users (id)
);

CREATE TABLE mastery_snapshots (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	week_start DATE NOT NULL, 
	pct INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (user_id, week_start), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX ix_mastery_snapshots_user_id ON mastery_snapshots (user_id);

CREATE TABLE xp_events (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	amount INTEGER NOT NULL, 
	reason VARCHAR(80) NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX ix_xp_events_created_at ON xp_events (created_at);

CREATE INDEX ix_xp_events_user_id ON xp_events (user_id);

CREATE TABLE daily_activity (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	day DATE NOT NULL, 
	seconds INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (user_id, day), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX ix_daily_activity_user_id ON daily_activity (user_id);

CREATE TABLE project_progress (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	project_id INTEGER NOT NULL, 
	milestone INTEGER NOT NULL, 
	code TEXT NOT NULL, 
	status VARCHAR(12) NOT NULL, 
	last_run JSON, 
	published_at TIMESTAMP WITHOUT TIME ZONE, 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (user_id, project_id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE INDEX ix_project_progress_user_id ON project_progress (user_id);

CREATE TABLE messages (
	id SERIAL NOT NULL, 
	learner_id INTEGER NOT NULL, 
	author_id INTEGER NOT NULL, 
	project_id INTEGER, 
	context VARCHAR(160) NOT NULL, 
	body TEXT NOT NULL, 
	read BOOLEAN NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(learner_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(author_id) REFERENCES users (id), 
	FOREIGN KEY(project_id) REFERENCES projects (id)
);

CREATE INDEX ix_messages_learner_id ON messages (learner_id);

CREATE TABLE notifications (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	kind VARCHAR(24) NOT NULL, 
	title VARCHAR(200) NOT NULL, 
	body TEXT NOT NULL, 
	link VARCHAR(200) NOT NULL, 
	read BOOLEAN NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX ix_notifications_user_id ON notifications (user_id);

CREATE TABLE chapter_versions (
	id SERIAL NOT NULL, 
	chapter_id INTEGER NOT NULL, 
	version INTEGER NOT NULL, 
	content JSON NOT NULL, 
	published_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	published_by INTEGER, 
	PRIMARY KEY (id), 
	UNIQUE (chapter_id, version), 
	FOREIGN KEY(chapter_id) REFERENCES chapters (id) ON DELETE CASCADE, 
	FOREIGN KEY(published_by) REFERENCES users (id)
);

CREATE INDEX ix_chapter_versions_chapter_id ON chapter_versions (chapter_id);

CREATE TABLE concepts (
	id SERIAL NOT NULL, 
	path_id INTEGER NOT NULL, 
	key VARCHAR(60) NOT NULL, 
	name VARCHAR(80) NOT NULL, 
	skill VARCHAR(120) NOT NULL, 
	chapter_id INTEGER, 
	x INTEGER NOT NULL, 
	y INTEGER NOT NULL, 
	requires JSON NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (path_id, key), 
	FOREIGN KEY(path_id) REFERENCES paths (id), 
	FOREIGN KEY(chapter_id) REFERENCES chapters (id)
);

CREATE TABLE chapter_progress (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	chapter_id INTEGER NOT NULL, 
	version INTEGER NOT NULL, 
	phases JSON NOT NULL, 
	current VARCHAR(12) NOT NULL, 
	started_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	completed_at TIMESTAMP WITHOUT TIME ZONE, 
	phase_since TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	active_seconds INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (user_id, chapter_id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(chapter_id) REFERENCES chapters (id) ON DELETE CASCADE
);

CREATE INDEX ix_chapter_progress_user_id ON chapter_progress (user_id);

CREATE TABLE player_states (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	chapter_id INTEGER NOT NULL, 
	phase VARCHAR(16) NOT NULL, 
	data JSON NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (user_id, chapter_id, phase), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(chapter_id) REFERENCES chapters (id) ON DELETE CASCADE
);

CREATE INDEX ix_player_states_user_id ON player_states (user_id);

CREATE TABLE attempts (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	chapter_id INTEGER NOT NULL, 
	phase VARCHAR(12) NOT NULL, 
	item_id VARCHAR(40) NOT NULL, 
	attempt_no INTEGER NOT NULL, 
	correct BOOLEAN NOT NULL, 
	answer JSON, 
	hint_level INTEGER NOT NULL, 
	ms INTEGER NOT NULL, 
	version INTEGER NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(chapter_id) REFERENCES chapters (id) ON DELETE CASCADE
);

CREATE INDEX ix_attempts_created_at ON attempts (created_at);

CREATE INDEX ix_attempts_user_id ON attempts (user_id);

CREATE INDEX ix_attempts_chapter_id ON attempts (chapter_id);

CREATE TABLE hint_opens (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	chapter_id INTEGER NOT NULL, 
	item_id VARCHAR(40) NOT NULL, 
	level INTEGER NOT NULL, 
	ms_since_shown INTEGER NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(chapter_id) REFERENCES chapters (id) ON DELETE CASCADE
);

CREATE INDEX ix_hint_opens_user_id ON hint_opens (user_id);

CREATE TABLE quiz_rounds (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	chapter_id INTEGER, 
	kind VARCHAR(12) NOT NULL, 
	version INTEGER NOT NULL, 
	question_refs JSON NOT NULL, 
	answers JSON NOT NULL, 
	per_question_sec INTEGER NOT NULL, 
	score INTEGER NOT NULL, 
	combo INTEGER NOT NULL, 
	best_combo INTEGER NOT NULL, 
	finished BOOLEAN NOT NULL, 
	pct INTEGER, 
	passed BOOLEAN, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(chapter_id) REFERENCES chapters (id) ON DELETE CASCADE
);

CREATE INDEX ix_quiz_rounds_user_id ON quiz_rounds (user_id);

CREATE TABLE exam_sessions (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	chapter_id INTEGER NOT NULL, 
	version INTEGER NOT NULL, 
	started_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	deadline TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	answers JSON NOT NULL, 
	flags JSON NOT NULL, 
	submitted_at TIMESTAMP WITHOUT TIME ZONE, 
	score INTEGER, 
	passed BOOLEAN, 
	results JSON, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(chapter_id) REFERENCES chapters (id) ON DELETE CASCADE
);

CREATE INDEX ix_exam_sessions_user_id ON exam_sessions (user_id);

CREATE TABLE submissions (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	kind VARCHAR(12) NOT NULL, 
	chapter_id INTEGER, 
	project_id INTEGER, 
	milestone INTEGER, 
	title VARCHAR(160) NOT NULL, 
	filename VARCHAR(80) NOT NULL, 
	code TEXT NOT NULL, 
	attempt_no INTEGER NOT NULL, 
	tests_passed INTEGER NOT NULL, 
	tests_total INTEGER NOT NULL, 
	error_line INTEGER, 
	status VARCHAR(12) NOT NULL, 
	summary TEXT NOT NULL, 
	reviewed_by INTEGER, 
	reviewed_at TIMESTAMP WITHOUT TIME ZONE, 
	seen_by_learner BOOLEAN NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(chapter_id) REFERENCES chapters (id) ON DELETE CASCADE, 
	FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE, 
	FOREIGN KEY(reviewed_by) REFERENCES users (id)
);

CREATE INDEX ix_submissions_user_id ON submissions (user_id);

CREATE TABLE notebooks (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	title VARCHAR(160) NOT NULL, 
	attached_chapter_id INTEGER, 
	cells JSON NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(attached_chapter_id) REFERENCES chapters (id) ON DELETE SET NULL
);

CREATE INDEX ix_notebooks_user_id ON notebooks (user_id);

CREATE TABLE assignments (
	id SERIAL NOT NULL, 
	mentor_id INTEGER NOT NULL, 
	learner_id INTEGER NOT NULL, 
	chapter_id INTEGER, 
	title VARCHAR(200) NOT NULL, 
	link VARCHAR(200) NOT NULL, 
	done BOOLEAN NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(mentor_id) REFERENCES users (id), 
	FOREIGN KEY(learner_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(chapter_id) REFERENCES chapters (id) ON DELETE CASCADE
);

CREATE INDEX ix_assignments_learner_id ON assignments (learner_id);

CREATE TABLE content_reports (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	chapter_id INTEGER NOT NULL, 
	item_id VARCHAR(40) NOT NULL, 
	body TEXT NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(chapter_id) REFERENCES chapters (id) ON DELETE CASCADE
);

CREATE TABLE concept_mastery (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	concept_id INTEGER NOT NULL, 
	tier INTEGER NOT NULL, 
	weak BOOLEAN NOT NULL, 
	weak_phase VARCHAR(12) NOT NULL, 
	weak_note TEXT NOT NULL, 
	last_evidence VARCHAR(200) NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (user_id, concept_id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(concept_id) REFERENCES concepts (id) ON DELETE CASCADE
);

CREATE INDEX ix_concept_mastery_user_id ON concept_mastery (user_id);

CREATE TABLE review_comments (
	id SERIAL NOT NULL, 
	submission_id INTEGER NOT NULL, 
	author_id INTEGER NOT NULL, 
	line INTEGER NOT NULL, 
	body TEXT NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(submission_id) REFERENCES submissions (id) ON DELETE CASCADE, 
	FOREIGN KEY(author_id) REFERENCES users (id)
);

CREATE INDEX ix_review_comments_submission_id ON review_comments (submission_id);

ALTER TABLE classes ADD FOREIGN KEY(mentor_id) REFERENCES users (id);
