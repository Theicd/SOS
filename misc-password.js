// חלק סיסמת שונות (misc-password.js) – חלון הגנת סיסמה לתפריט שונות | HYPER CORE TECH
(function initMiscPassword(window) {
  const App = window.NostrApp || (window.NostrApp = {});
  const doc = window.document;
  
  // סיסמת קבועה להגנת תפריט שונות
  const MISC_PASSWORD = '2048';
  
  // יצירת חלון סיסמה
  function createPasswordModal() {
    const existing = doc.getElementById('miscPasswordModal');
    if (existing) existing.remove();
    
    const modal = doc.createElement('div');
    modal.id = 'miscPasswordModal';
    modal.className = 'misc-password-modal';
    modal.innerHTML = `
      <div class="misc-password-backdrop"></div>
      <div class="misc-password-dialog" role="dialog" aria-modal="true">
        <div class="misc-password-header">
          <h3 class="misc-password-title">הגנת תפריט שונות</h3>
          <button type="button" class="misc-password-close" aria-label="סגור">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div class="misc-password-body">
          <p class="misc-password-message">הזן סיסמה לגישה לתפריט שונות</p>
          <div class="misc-password-input-group">
            <input 
              type="password" 
              id="miscPasswordInput" 
              class="misc-password-input" 
              placeholder="הזן סיסמה..."
              autocomplete="off"
            />
            <button type="button" class="misc-password-toggle" id="miscPasswordToggle">
              <i class="fa-solid fa-eye"></i>
            </button>
          </div>
          <div class="misc-password-error" id="miscPasswordError" hidden>סיסמה שגויה</div>
        </div>
        <div class="misc-password-actions">
          <button type="button" class="misc-password-btn misc-password-btn--cancel" id="miscPasswordCancel">
            ביטול
          </button>
          <button type="button" class="misc-password-btn misc-password-btn--confirm" id="miscPasswordConfirm">
            אישור
          </button>
        </div>
      </div>
    `;
    
    doc.body.appendChild(modal);
    return modal;
  }
  
  // פתיחת חלון סיסמה
  window.openMiscPasswordPrompt = function openMiscPasswordPrompt(onSuccess) {
    const modal = createPasswordModal();
    const input = modal.querySelector('#miscPasswordInput');
    const toggle = modal.querySelector('#miscPasswordToggle');
    const confirm = modal.querySelector('#miscPasswordConfirm');
    const cancel = modal.querySelector('#miscPasswordCancel');
    const close = modal.querySelector('.misc-password-close');
    const error = modal.querySelector('#miscPasswordError');
    const backdrop = modal.querySelector('.misc-password-backdrop');
    
    let isVisible = false;
    
    const closeModal = () => {
      modal.remove();
    };
    
    const showError = () => {
      error.hidden = false;
      input.classList.add('misc-password-input--error');
      input.focus();
      input.select();
    };
    
    const hideError = () => {
      error.hidden = true;
      input.classList.remove('misc-password-input--error');
    };
    
    const checkPassword = () => {
      const value = input.value.trim();
      hideError();
      
      if (value === MISC_PASSWORD) {
        closeModal();
        if (typeof onSuccess === 'function') {
          onSuccess();
        }
      } else {
        showError();
      }
    };
    
    // הצגת/הסתרת סיסמה
    toggle.addEventListener('click', () => {
      const type = input.type === 'password' ? 'text' : 'password';
      input.type = type;
      toggle.innerHTML = type === 'password' 
        ? '<i class="fa-solid fa-eye"></i>' 
        : '<i class="fa-solid fa-eye-slash"></i>';
    });
    
    // אירועים
    confirm.addEventListener('click', checkPassword);
    cancel.addEventListener('click', closeModal);
    close.addEventListener('click', closeModal);
    backdrop.addEventListener('click', closeModal);
    
    // Enter לאישור
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        checkPassword();
      } else if (e.key === 'Escape') {
        closeModal();
      }
    });
    
    // פוקוס אוטומטי
    setTimeout(() => {
      input.focus();
      isVisible = true;
    }, 100);
    
    return modal;
  };
  
})(window);
