// סקריפט דיבאג - הצגת כל לינקי הווידאו המקוריים והמירורים
(function debugVideoUrls() {
  console.log('=== Debug Video URLs ===');
  
  const videoContainers = document.querySelectorAll('[data-video-url]');
  
  if (videoContainers.length === 0) {
    console.log('לא נמצאו וידאוים בדף');
    return;
  }
  
  console.log(`נמצאו ${videoContainers.length} וידאוים:\n`);
  
  const results = [];
  
  videoContainers.forEach((container, index) => {
    const originalUrl = container.dataset.videoUrl;
    const hash = container.dataset.videoHash || 'אין';
    const mirrorsStr = container.dataset.videoMirrors || '';
    const mirrors = mirrorsStr ? mirrorsStr.split(',') : [];
    const video = container.querySelector('video');
    const currentSrc = video?.src || 'לא נטען';
    
    const postId = container.closest('[data-post-id]')?.dataset?.postId || 'לא ידוע';
    
    const info = {
      index: index + 1,
      postId: postId.slice(0, 8),
      originalUrl,
      hash: hash.slice(0, 16),
      mirrors,
      currentSrc: currentSrc.startsWith('blob:') ? 'blob (נטען מקומית)' : currentSrc,
      isOriginalDomain: originalUrl.includes('nostr.build') || originalUrl.includes('void.cat'),
    };
    
    results.push(info);
    
    console.log(`\n${index + 1}. פוסט: ${info.postId}`);
    console.log(`   לינק מקורי: ${originalUrl}`);
    console.log(`   Hash: ${info.hash}`);
    console.log(`   מספר mirrors: ${mirrors.length}`);
    if (mirrors.length > 0) {
      mirrors.forEach((mirror, i) => {
        console.log(`   Mirror ${i + 1}: ${mirror.slice(0, 80)}...`);
      });
    }
    console.log(`   נטען כרגע מ: ${info.currentSrc}`);
    console.log(`   דומיין מקורי: ${info.isOriginalDomain ? '✓ כן' : '✗ לא'}`);
  });
  
  console.log('\n=== סיכום ===');
  const withOriginal = results.filter(r => r.isOriginalDomain).length;
  const withMirrors = results.filter(r => r.mirrors.length > 0).length;
  console.log(`סה"כ וידאוים: ${results.length}`);
  console.log(`עם לינק מקורי (nostr.build/void.cat): ${withOriginal}`);
  console.log(`עם mirrors: ${withMirrors}`);
  
  // שמירת התוצאות ל-window כדי שתוכל לגשת אליהן
  window.videoUrlsDebug = results;
  console.log('\nהתוצאות נשמרו ב-window.videoUrlsDebug');
  console.log('כדי לראות את כל הלינקים המקוריים, הקלד: window.videoUrlsDebug.map(v => v.originalUrl)');
  
  return results;
})();
