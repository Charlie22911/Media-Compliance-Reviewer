const fs=require('fs'),path=require('path');
module.exports=html=>{
 const screen=fs.readFileSync(path.join(__dirname,'../src/media-startup-screen.html'),'utf8');
 const marker='<!--MEDIA_STARTUP_SCREEN_START-->\n'+screen+'\n<!--MEDIA_STARTUP_SCREEN_END-->';
 html=html.replace(/<!--MEDIA_STARTUP_SCREEN_START-->[\s\S]*?<!--MEDIA_STARTUP_SCREEN_END-->\s*/g,'');
 if(!/<body\b[^>]*>/.test(html))throw Error('Missing body for the startup loading screen.');
 return html.replace(/<body\b[^>]*>/,match=>match+'\n'+marker+'\n');
};
