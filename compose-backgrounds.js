(function initComposeBackgrounds(window){
  const App = window.NostrApp || (window.NostrApp = {});

  const Bg = {
    bind(ctx){
      // ctx: { elements, state, setStatus, showMediaPreview, getText }
      this.ctx = ctx;
      const { elements } = ctx;
      if (elements.bgToggle) {
        elements.bgToggle.addEventListener('click', () => {
          if (ctx.state.media) {
            ctx.setStatus('כדי להשתמש ברקע, הסר תחילה מדיה שהוספת.', 'info');
            return;
          }
          this.setActive(!this.active);
        });
      }
      if (elements.textarea) {
        elements.textarea.addEventListener('input', () => {
          if (this.active && this.bgImage) {
            this.renderToMedia();
          }
        });
      }
    },

    onOpenCompose(){
      this.setActive(false);
      if (this.ctx?.elements?.bgClear) this.ctx.elements.bgClear.setAttribute('hidden','');
    },

    onReset(){
      this.setActive(false);
      if (this.ctx?.elements?.bgClear) this.ctx.elements.bgClear.setAttribute('hidden','');
    },

    setActive(active){
      this.active = !!active;
      const { elements } = this.ctx;
      if (!this.active) {
        this.clearSelection();
        if (elements.bgGallery) elements.bgGallery.setAttribute('hidden','');
        if (elements.bgClear) elements.bgClear.setAttribute('hidden','');
        return;
      }
      this.fetchBackgrounds().then((urls)=>{
        this.urls = urls || [];
        this.renderGallery();
      });
    },

    async fetchBackgrounds(){
      try{
        const page = Math.max(1, Math.floor(Math.random()*50));
        const res = await fetch(`https://picsum.photos/v2/list?page=${page}&limit=12`);
        const arr = await res.json();
        return Array.isArray(arr) ? arr.map(x=> x && x.id ? `https://picsum.photos/id/${x.id}/1080/1080` : null).filter(Boolean) : [];
      }catch(e){
        console.warn('Picsum fetch failed', e);
        return [];
      }
    },

    renderGallery(){
      const { elements } = this.ctx;
      if (!elements.bgGallery) return;
      const urls = this.urls || [];
      if (!urls.length){
        elements.bgGallery.innerHTML = '';
        elements.bgGallery.setAttribute('hidden','');
        return;
      }
      elements.bgGallery.innerHTML = urls.slice(0,12).map(u=>`<button type="button" class="compose-bg__item" data-bg="${u}" style="background-image:url('${u}')"></button>`).join('');
      elements.bgGallery.removeAttribute('hidden');
      Array.from(elements.bgGallery.querySelectorAll('button.compose-bg__item')).forEach(btn=>{
        btn.addEventListener('click', ()=>{
          const url = btn.getAttribute('data-bg');
          if (url) this.select(url, btn);
        });
      });
    },

    async select(url, btn){
      const { elements } = this.ctx;
      this.selectedUrl = url;
      if (elements.bgGallery){
        elements.bgGallery.querySelectorAll('.compose-bg__item').forEach(el=>el.classList.remove('is-selected'));
        if (btn) btn.classList.add('is-selected');
      }
      try {
        // שלב 1: הורד כתמונה כ-blob והמר ל-Data URL כדי למנוע tainted canvas
        const resp = await fetch(url, { mode: 'cors', cache: 'no-store' });
        const blob = await resp.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = reject;
          fr.readAsDataURL(blob);
        });
        // שלב 2: טען את ה-Data URL לתוך Image מקומי
        const img = new Image();
        img.onload = () => {
          this.bgImage = img;
          // המרה מיידית למדיה
          this.renderToMedia();
          // החלת הרקע בתוך תיבת הטקסט והסתרת הגלריה
          if (this.ctx.applyTextareaBg) this.ctx.applyTextareaBg(dataUrl);
          if (elements.bgGallery) {
            elements.bgGallery.innerHTML = '';
            elements.bgGallery.setAttribute('hidden','');
          }
          if (elements.bgClear) elements.bgClear.removeAttribute('hidden');
          // ביטול preview למטה כדי למנוע גלילה מיותרת
          const pc = elements.previewContainer;
          if (pc) {
            pc.classList.remove('is-visible');
            pc.setAttribute('hidden','');
          }
          if (elements.previewImage) {
            elements.previewImage.style.display = 'none';
            elements.previewImage.src = '';
          }
          if (elements.previewVideo) {
            elements.previewVideo.style.display = 'none';
            elements.previewVideo.removeAttribute('src');
            elements.previewVideo.load();
          }
        };
        img.onerror = ()=> this.ctx.setStatus('טעינת הרקע נכשלה. נסה רקע אחר.', 'error');
        img.src = dataUrl;
      } catch (e) {
        console.warn('Background select failed', e);
        this.ctx.setStatus('טעינת הרקע נכשלה. נסה רקע אחר.', 'error');
      }
    },

    renderToMedia(){
      const text = (this.ctx.getText() || '').trim();
      const textOnlyMode = Boolean(this.ctx.state?.bgTextOnly);
      if (!this.active || !this.bgImage) return;
      const baseSize = 1080;
      const canvas = document.createElement('canvas');
      canvas.width = baseSize; canvas.height = baseSize;
      const ctx = canvas.getContext('2d');
      // draw bg
      const img = this.bgImage;
      const ratio = Math.max(baseSize / img.width, baseSize / img.height);
      const w = img.width * ratio; const h = img.height * ratio;
      const dx = (baseSize - w) / 2; const dy = (baseSize - h) / 2;
      ctx.drawImage(img, dx, dy, w, h);
      // שכבת כהות קלה לשיפור ניגודיות תמידית
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(0,0,baseSize,baseSize);
      // חלק טקסט-על-תמונה (compose-backgrounds.js) – מצייר טקסט על הרקע רק אם המשתמש הפעיל מצב "טקסט רק על התמונה" | HYPER CORE TECH
      if (textOnlyMode && text) {
        const padding = 80; const maxWidth = baseSize - padding*2;
        let fontSize = 64; ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillStyle = '#fff'; ctx.strokeStyle='rgba(0,0,0,0.5)'; ctx.lineWidth=4;
        ctx.font = `${fontSize}px sans-serif`;
        const lines = this.wrapText(ctx, text, maxWidth);
        const lineHeight = fontSize * 1.3;
        const totalH = lines.length * lineHeight; let y = baseSize/2 - totalH/2 + lineHeight/2;
        lines.forEach(ln=>{ ctx.strokeText(ln, baseSize/2, y); ctx.fillText(ln, baseSize/2, y); y += lineHeight; });
      }
      const dataUrl = this.exportCanvasUnderLimit(canvas);
      this.ctx.state.media = { type:'image', dataUrl };
      this.ctx.state.fx = 'zoomin';
      // במצב רקע – לא מציגים preview למטה, רק מחילים רקע בתיבת הטקסט
      if (this.ctx.applyTextareaBg) this.ctx.applyTextareaBg(dataUrl);
      if (this.ctx.elements?.bgClear) this.ctx.elements.bgClear.removeAttribute('hidden');
      const els = this.ctx.elements || {};
      if (els.previewContainer) {
        els.previewContainer.classList.remove('is-visible');
        els.previewContainer.setAttribute('hidden','');
      }
      if (els.previewImage) { els.previewImage.style.display='none'; els.previewImage.src=''; }
      if (els.previewVideo) { els.previewVideo.style.display='none'; els.previewVideo.removeAttribute('src'); els.previewVideo.load(); }
    },

    exportCanvasUnderLimit(canvas){
      // חלק רקעים – דחיסה אדפטיבית כמו העלאת קובץ מקומי
      const appObj = window.NostrApp || window.App || {};
      const limit = appObj.MAX_INLINE_MEDIA_LENGTH || appObj.MAX_INLINE_PICTURE_LENGTH || 250000; // ברירת מחדל סלחנית
      const qualities = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25, 0.2, 0.15];
      const sizes = [1080, 960, 840, 720, 640, 600, 512, 448, 384, 320];
      for (let sIdx = 0; sIdx < sizes.length; sIdx += 1) {
        const target = sizes[sIdx];
        if (canvas.width !== target || canvas.height !== target) {
          const tmp = document.createElement('canvas');
          tmp.width = target; tmp.height = target;
          const tctx = tmp.getContext('2d');
          tctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, target, target);
          canvas = tmp;
        }
        for (let qIdx = 0; qIdx < qualities.length; qIdx += 1) {
          const q = qualities[qIdx];
          const url = canvas.toDataURL('image/jpeg', q);
          if (!limit || url.length <= limit) {
            return url;
          }
        }
      }
      // אם לא עמדנו במגבלה – נחזיר את הקומפרסיה החזקה ביותר, עדיף מאשר להיכשל
      return canvas.toDataURL('image/jpeg', 0.12);
    },

    wrapText(ctx, text, maxWidth){
      let fontSize = 64; let lines = [];
      const split = (t)=>{
        const words = (t||'').split(/\s+/); const out = []; let line='';
        for (let i=0;i<words.length;i+=1){
          const test = line ? `${line} ${words[i]}` : words[i];
          if (ctx.measureText(test).width > maxWidth && line){ out.push(line); line = words[i]; }
          else { line = test; }
        }
        if (line) out.push(line);
        return out;
      };
      ctx.font = `${fontSize}px sans-serif`;
      lines = split(text);
      while (lines.length > 6 && fontSize > 28){ fontSize -= 4; ctx.font = `${fontSize}px sans-serif`; lines = split(text); }
      return lines;
    },

    clearSelection(){
      this.selectedUrl = ''; this.bgImage = null;
      const { elements } = this.ctx;
      if (elements && elements.bgGallery){ elements.bgGallery.querySelectorAll('.compose-bg__item').forEach(el=>el.classList.remove('is-selected')); }
    }
  };

  App.bg = Bg;
})(window);
