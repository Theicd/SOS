// סקריפט לכפיית טעינה מהלינקים המקוריים (ללא mirrors)
(function forceOriginalUrls() {
  console.log('=== Force Original URLs ===');
  console.log('כופה טעינה מהלינקים המקוריים בלבד...\n');
  
  const videoContainers = document.querySelectorAll('[data-video-url]');
  
  if (videoContainers.length === 0) {
    console.log('לא נמצאו וידאוים בדף');
    return;
  }
  
  let reloadedCount = 0;
  let skippedCount = 0;
  
  videoContainers.forEach((container, index) => {
    const originalUrl = container.dataset.videoUrl;
    const video = container.querySelector('video');
    
    if (!video) {
      console.log(`${index + 1}. דילוג - אין אלמנט video`);
      skippedCount++;
      return;
    }
    
    // בדיקה אם הווידאו כבר נטען מהלינק המקורי
    const currentSrc = video.src;
    const isLoadedFromOriginal = currentSrc && !currentSrc.startsWith('blob:') && currentSrc === originalUrl;
    
    if (isLoadedFromOriginal) {
      console.log(`${index + 1}. דילוג - כבר נטען מהמקור: ${originalUrl.slice(0, 60)}...`);
      skippedCount++;
      return;
    }
    
    // טעינה מחדש מהלינק המקורי
    console.log(`${index + 1}. טוען מחדש מהמקור: ${originalUrl.slice(0, 60)}...`);
    
    // שמירת מצב הפעלה נוכחי
    const wasPlaying = !video.paused;
    const currentTime = video.currentTime;
    
    // טעינה מהלינק המקורי
    video.src = originalUrl;
    video.load();
    
    // שחזור מצב הפעלה
    if (wasPlaying) {
      video.currentTime = currentTime;
      video.play().catch(() => {
        console.warn(`${index + 1}. לא ניתן להפעיל אוטומטית`);
      });
    }
    
    reloadedCount++;
  });
  
  console.log('\n=== סיכום ===');
  console.log(`סה"כ וידאוים: ${videoContainers.length}`);
  console.log(`נטענו מחדש: ${reloadedCount}`);
  console.log(`דולגו: ${skippedCount}`);
  console.log('\nכל הוידאוים עכשיו נטענים מהלינקים המקוריים!');
  
  return { reloadedCount, skippedCount, total: videoContainers.length };
})();
