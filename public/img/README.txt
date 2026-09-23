Drop your generated images here (see thoughtlog-cover-prompt-library.md):

  og-default.jpg      -> social share preview (prompt #19), ideally 1200x630
  default-cover.jpg   -> fallback cover for posts without one (any 16:9)
  about-header.jpg    -> About page header (prompt #18)
  archive-header.jpg  -> Archive page header (prompt #21)
  404.png             -> page-not-found illustration (prompt #22)
  support-qr.jpg       -> DuitNow/TnG QR shown in the collapsed "Support" box
                          on the About page (square, ~400x400 works well)

All are optional. Missing files are handled gracefully (slots simply
don't render). Compress to <300KB each before uploading (squoosh.app).

Upload from your PC:
  scp img-file.jpg user@100.77.41.4:~/thoughtlog/public/img/
