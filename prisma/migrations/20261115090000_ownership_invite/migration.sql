-- An invitation that carries a project hand-over: the person joins as a manager and then gets the transfer offer.
ALTER TABLE "project_invitations" ADD COLUMN "ownership_keep_access" BOOLEAN;
