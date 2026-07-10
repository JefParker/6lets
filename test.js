const document = {
    querySelectorAll: () => [{classList: {remove: () => {}}}],
    getElementById: (id) => {
        if(id === 'editor') return {style: {display: 'none'}};
        if(id === 'am-flip-card' || id === 'pm-flip-card') return {classList: {remove: () => {}}};
        if(id === 'selected-date-display' || id === 'am-label' || id === 'pm-label') return {textContent: ''};
        if(id === 'am-word' || id === 'pm-word') return {value: ''};
        return null;
    }
};

let dashboardSelectedDateStr = null;

async function selectAdminDate(dateStr, element) {
    document.querySelectorAll('.day.selected').forEach(e => e.classList.remove('selected'));
    if(element) element.classList.add('selected');
    dashboardSelectedDateStr = dateStr;
    
    document.getElementById('am-flip-card').classList.remove('flipped');
    document.getElementById('pm-flip-card').classList.remove('flipped');
    
    const editor = document.getElementById('editor');
    editor.style.display = 'block';
    
    console.log("Editor display is now:", editor.style.display);
}

selectAdminDate("2026-07-09", {classList: {add: () => {}}}).catch(console.error);
