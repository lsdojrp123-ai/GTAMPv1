fx_version 'cerulean'
game 'gta5'

name 'chat'
description 'Built-in chat system'
author 'GTAMP'
version '1.0.0'

client_scripts {
  'client/chat.js'
}
server_scripts {
  'server/chat.js'
}

ui_page 'nui/index.html'

files {
  'nui/index.html',
  'nui/style.css',
  'nui/chat.js'
}
