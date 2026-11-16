-- 与架构 4.6 对齐：为文章版本内容建立全文检索 GIN 索引。
-- 中文短语仍由已有的 pg_trgm 索引兜底，两者在查询中以 OR 组合。
CREATE INDEX "kb_article_versions_search_tsv_idx"
  ON "kb_article_versions"
  USING GIN (to_tsvector('simple', "title" || ' ' || "body"));
