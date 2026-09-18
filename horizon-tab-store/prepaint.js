/* Horizon pre-paint hint — parser-blocking <script src> in <head>.
   tab.js boots async (chrome.storage reads always miss frame one), so a
   fresh tab paints the default slate theme, then swaps to the user's bg —
   the one-frame slate flash. This script runs before first paint and
   re-applies the last-saved theme + background from a synchronous
   localStorage hint (written by writePrepaintHint in tab.js). It only
   touches <html> attributes and inherited vars.
   If the hint is missing or stale, boot corrects everything as before.
   Also pre-renders the clock/date text: boot awaits chrome.storage before
   scheduleClock() runs, so frame one shows "--:--" until the async read
   resolves. Date uses en-US like updateClock in tab.js. */
(function(){
  var root=document.documentElement,hint=null;
  try{hint=JSON.parse(localStorage.getItem("hzPrepaint")||"null")}catch(e){return}
  if(!hint||typeof hint!=="object")return;
  /* Mirror of applyGlassOpacity / applyTextColor in tab.js. */
  if(hint.glass!=null&&isFinite(+hint.glass))root.style.setProperty("--surface-opacity",String(+hint.glass));
  var t=hint.text;
  if(t&&/^#[0-9a-fA-F]{6}$/.test(t)){
    var r=parseInt(t.slice(1,3),16),g=parseInt(t.slice(3,5),16),b=parseInt(t.slice(5,7),16);
    root.style.setProperty("--text",t);
    root.style.setProperty("--text-dim","rgba("+r+","+g+","+b+",0.7)");
    root.style.setProperty("--text-muted","rgba("+r+","+g+","+b+",0.45)");
    root.style.setProperty("--hero-text",t);
    root.style.setProperty("--hero-sub","rgba("+r+","+g+","+b+",0.7)");
  }
  if(hint.bg){
    /* Mirror of bgVars in tab.js: veil alpha + direction, blur. The
       html.has-bg selectors in tab.css paint the layer from these
       inherited vars until boot adds .has-image itself. */
    var dark=hint.bgDark!==false,dim=hint.bgDim==null?50:+hint.bgDim,blur=hint.bgBlur==null?0:+hint.bgBlur;
    root.setAttribute("data-theme",dark?"darkbg":"lightbg");
    root.classList.add("has-bg");
    if(blur>0)root.classList.add("has-blur");
    root.style.setProperty("--user-bg","url("+hint.bg+")");
    root.style.setProperty("--overlay-c",dark?"rgba(0,0,0,"+(dim/100).toFixed(2)+")":"rgba(255,255,255,"+(dim/100).toFixed(2)+")");
    root.style.setProperty("--bg-blur",blur+"px");
    return;
  }
  var theme=hint.theme||"slate";
  if(theme==="modern"){var h=new Date().getHours();theme=(h>=6&&h<20)?"modern-day":"modern"}
  if(theme==="custom"&&hint.customBg&&/^#[0-9a-fA-F]{6}$/.test(hint.customBg)){
    /* Compact mirror of applyCustomTheme: raw colors + light/dark mode
       so derived vars exist before boot recomputes them exactly. */
    var br=parseInt(hint.customBg.slice(1,3),16),bg=parseInt(hint.customBg.slice(3,5),16),bb=parseInt(hint.customBg.slice(5,7),16);
    var light=(0.299*br+0.587*bg+0.114*bb)/255>.5;
    root.setAttribute("data-theme","custom");
    if(light)root.setAttribute("data-custom-mode","light");
    root.style.setProperty("--user-bg",hint.customBg);
    if(hint.customAccent&&/^#[0-9a-fA-F]{6}$/.test(hint.customAccent))root.style.setProperty("--user-accent",hint.customAccent);
    return;
  }
  root.setAttribute("data-theme",theme);
})();
