(function() {
  try {
    var t = localStorage.getItem('quivit-theme');
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
    var c = localStorage.getItem('quivit-custom-css');
    if (c) {
      var s = document.createElement('style');
      s.id = 'custom-css';
      s.textContent = c;
      document.head.appendChild(s);
    }
  } catch(e) {}
})();
