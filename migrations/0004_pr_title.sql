-- PR title, captured from the pull_request webhook payload so the dashboard
-- lists can show what a PR is, not just its number. Nullable: rows created
-- before this column (or by paths that don't carry a title) simply have none,
-- and the next pull_request event fills it in.
ALTER TABLE prs ADD COLUMN title TEXT;
