-- CreateTable
CREATE TABLE "user_guide_sections" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_guide_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_guide_images" (
    "id" TEXT NOT NULL,
    "section_id" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "data_base64" TEXT NOT NULL,
    "caption" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "uploaded_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_guide_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_guide_images_section_id_order_idx" ON "user_guide_images"("section_id", "order");

-- AddForeignKey
ALTER TABLE "user_guide_images" ADD CONSTRAINT "user_guide_images_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "user_guide_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
