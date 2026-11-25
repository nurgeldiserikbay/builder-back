-- Module stages (PRODUCT_LIFECYCLE §4.9): a module of an application's accepted plan becomes its own stage m_<module>.
ALTER TABLE "project_stages" ADD COLUMN "title" VARCHAR(120);
ALTER TABLE "project_stages" ADD COLUMN "module_key" VARCHAR(32);
