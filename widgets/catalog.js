window.WIDGET_MARKET = [
  {
    title: "Santa",
    widgets: [
      { id: "countdown", file: "countdown.html", title: "Santa Countdown", desc: "Festive countdown to Santa takeoff.", w: 72, h: 28, fields: [] },
      { id: "route", file: "route.html", title: "Santa Route Status", desc: "Current stop, next stop and time left.", w: 52, h: 48, fields: [] }
    ]
  },
  {
    title: "Santa Tracking",
    widgets: [
      { id: "santa-countdown", file: "santa-countdown.html", title: "Santa Tracking Countdown", desc: "Counts down to Christmas Eve (24 Dec, 10:00 GMT).", w: 72, h: 28, fields: [] },
      { id: "santa-route", file: "santa-route.html", title: "Santa Route", desc: "Live delivery status along the route.", w: 52, h: 48, fields: [] },
      { id: "santa-route-wide", file: "santa-route-wide.html", title: "Santa Route Wide", desc: "Wide live route (800×280).", w: 90, h: 22, fields: [] },
      { id: "journey-end", file: "journey-end.html", title: "Until His Journey Ends", desc: "Until Santa lands back at the North Pole.", w: 72, h: 28, fields: [] }
    ]
  },
  {
    title: "New Year",
    widgets: [
      { id: "ny-countdown", file: "ny-countdown.html", title: "Next Midnight Countdown", desc: "Counts down to the nearest timezone midnight.", w: 56, h: 36, fields: [] },
      { id: "ny-schedule", file: "ny-schedule.html", title: "Incoming New Years (Large)", desc: "Detailed cards for the next 3 zones.", w: 56, h: 52, fields: [] },
      { id: "ny-schedule-compact", file: "ny-schedule-compact.html", title: "Incoming New Years (Compact)", desc: "Small list of upcoming zones.", w: 40, h: 48, fields: [] },
      { id: "ny-toast", file: "ny-toast.html", title: "Celebration Toast", desc: "Pop-up for the current New Year.", w: 48, h: 28, fields: [] },
      { id: "ny-facts", file: "ny-facts.html", title: "New Year Facts", desc: "Rotating fun facts every 20 seconds.", w: 48, h: 32, fields: [] }
    ]
  },
  {
    title: "Chat",
    widgets: [
      { id: "chat-effects", file: "chat-effects.html", title: "Onscreen Effects", desc: "Full-screen FX from chat commands.", w: 100, h: 100, fields: [
        { key: "videoId", label: "YouTube Video ID", placeholder: "cwFdM7uDY3E" },
        { key: "who", label: "Who can trigger", type: "select", value: "everyone", options: [
          { value: "everyone", label: "Everyone" },
          { value: "mods", label: "Mods and owner only" }
        ] },
        { key: "cooldown", label: "Cooldown seconds", placeholder: "4", value: "4" }
      ] },
      { id: "chat-status", file: "chat-status.html", title: "Chat Status", desc: "Change a status with !status in chat.", w: 56, h: 18, fields: [
        { key: "videoId", label: "YouTube Video ID", placeholder: "cwFdM7uDY3E" },
        { key: "who", label: "Who can change it", type: "select", value: "mods", options: [
          { value: "owner", label: "Owner" },
          { value: "mods", label: "Mods (and owner)" },
          { value: "custom", label: "Custom usernames" }
        ] },
        { key: "usernames", label: "Custom usernames", placeholder: "@name", type: "textarea" },
        { key: "command", label: "Command", placeholder: "!status", value: "!status" },
        { key: "text", label: "Starting status", placeholder: "Waiting...", value: "Waiting..." }
      ] },
      { id: "chat-overlay", file: "chat-overlay.html", title: "Chat Overlay", desc: "Live YouTube chat with avatars.", w: 34, h: 62, fields: [
        { key: "videoId", label: "YouTube Video ID", placeholder: "cwFdM7uDY3E" },
        { key: "max", label: "Max messages", placeholder: "12", value: "12" }
      ] },
      { id: "chat-poll", file: "chat-poll.html", title: "Chat Poll", desc: "Vote by typing 1, 2, 3 or 4.", w: 40, h: 42, fields: [
        { key: "videoId", label: "YouTube Video ID", placeholder: "cwFdM7uDY3E" },
        { key: "question", label: "Question", placeholder: "Chat Poll", value: "Chat Poll" },
        { key: "option1", label: "Option 1", placeholder: "Yes", value: "Yes" },
        { key: "option2", label: "Option 2", placeholder: "No", value: "No" },
        { key: "option3", label: "Option 3", placeholder: "" },
        { key: "option4", label: "Option 4", placeholder: "" }
      ] },
      { id: "chat-latest", file: "chat-latest.html", title: "Latest Message", desc: "Big popup of the latest chat line.", w: 52, h: 22, fields: [
        { key: "videoId", label: "YouTube Video ID", placeholder: "cwFdM7uDY3E" }
      ] },
      { id: "chat-avatars", file: "chat-avatars.html", title: "Recent Chatters", desc: "Avatar row of people who just talked.", w: 56, h: 16, fields: [
        { key: "videoId", label: "YouTube Video ID", placeholder: "cwFdM7uDY3E" },
        { key: "max", label: "Max avatars", placeholder: "10", value: "10" }
      ] },
      { id: "chat-highlight", file: "chat-highlight.html", title: "Keyword Highlight", desc: "Pops up when someone says a word.", w: 48, h: 22, fields: [
        { key: "videoId", label: "YouTube Video ID", placeholder: "cwFdM7uDY3E" },
        { key: "keyword", label: "Keyword", placeholder: "santa", value: "santa" }
      ] },
      { id: "chat-giveaway", file: "chat-giveaway.html", title: "Giveaway", desc: "!enter to join. Mods type !draw.", w: 40, h: 28, fields: [
        { key: "videoId", label: "YouTube Video ID", placeholder: "cwFdM7uDY3E" },
        { key: "command", label: "Join command", placeholder: "!enter", value: "!enter" },
        { key: "draw", label: "Draw command", placeholder: "!draw", value: "!draw" }
      ] },
      { id: "chat-top", file: "chat-top.html", title: "Top Chatters", desc: "Leaderboard of who talks the most.", w: 36, h: 42, fields: [
        { key: "videoId", label: "YouTube Video ID", placeholder: "cwFdM7uDY3E" },
        { key: "max", label: "People to show", placeholder: "5", value: "5" }
      ] },
      { id: "chat-paid", file: "chat-paid.html", title: "Paid Messages", desc: "Alert for Super Chats.", w: 48, h: 24, fields: [
        { key: "videoId", label: "YouTube Video ID", placeholder: "cwFdM7uDY3E" }
      ] },
      { id: "chat-qa", file: "chat-qa.html", title: "Q&A Board", desc: "Questions that start with !q.", w: 40, h: 48, fields: [
        { key: "videoId", label: "YouTube Video ID", placeholder: "cwFdM7uDY3E" },
        { key: "prefix", label: "Question prefix", placeholder: "!q", value: "!q" }
      ] },
      { id: "chat-activity", file: "chat-activity.html", title: "Chat Activity", desc: "Messages per minute meter.", w: 36, h: 20, fields: [
        { key: "videoId", label: "YouTube Video ID", placeholder: "cwFdM7uDY3E" }
      ] }
    ]
  },
  {
    title: "Stream",
    widgets: [
      { id: "subgoal", file: "subgoal.html", title: "Subscriber Goal", desc: "Progress bar every N subscribers.", w: 56, h: 20, fields: [
        { key: "channelId", label: "Channel ID", placeholder: "UC..." },
        { key: "step", label: "Goal step", placeholder: "50", value: "50" }
      ] },
      { id: "social", file: "social.html", title: "Social Rotator", desc: "Rotates YouTube and Discord messages.", w: 48, h: 16, fields: [
        { key: "youtube", label: "YouTube text", placeholder: "Subscribe!", value: "Subscribe!" },
        { key: "discord", label: "Discord text", placeholder: "Join our Discord!", value: "Join our Discord!" }
      ] },
      { id: "latest", file: "latest.html", title: "Latest Video", desc: "Most recent channel upload.", w: 40, h: 42, fields: [
        { key: "channelId", label: "Channel ID", placeholder: "UC..." }
      ] },
      { id: "views", file: "views.html", title: "Total Views", desc: "Total channel view counter.", w: 36, h: 18, fields: [
        { key: "channelId", label: "Channel ID", placeholder: "UC..." }
      ] },
      { id: "marquee", file: "marquee.html", title: "Scrolling Text", desc: "Bottom bar with a looping announcement.", w: 100, h: 14, fields: [
        { key: "text", label: "Text", type: "textarea", value: "Welcome to the Stream! • Subscribe!" },
        { key: "textColor", label: "Text color", type: "color", value: "#ffffff" },
        { key: "bgColor", label: "Background color", type: "color", value: "#D42426" },
        { key: "borderColor", label: "Border color", type: "color", value: "#FFD700" },
        { key: "font", label: "Font", type: "select", value: "outfit", options: [
          { value: "outfit", label: "Outfit" },
          { value: "lobster", label: "Lobster" },
          { value: "montserrat", label: "Montserrat" },
          { value: "bebas", label: "Bebas Neue" },
          { value: "pacifico", label: "Pacifico" },
          { value: "rubik", label: "Rubik" }
        ] },
        { key: "speed", label: "Speed", type: "select", value: "medium", options: [
          { value: "slow", label: "Slow" },
          { value: "medium", label: "Medium" },
          { value: "fast", label: "Fast" },
          { value: "turbo", label: "Very fast" }
        ] },
        { key: "repeat", label: "Repeat", type: "select", value: "yes", options: [
          { value: "yes", label: "Loop forever" },
          { value: "no", label: "Scroll once" }
        ] }
      ] },
      { id: "stream", file: "stream.html", title: "Live Stream Stats", desc: "Live viewers, likes, and viewer goal.", w: 40, h: 36, fields: [
        { key: "videoId", label: "YouTube Video ID", placeholder: "dQw4w9WgXcQ" }
      ] },
      { id: "datetime", file: "datetime.html", title: "Date & Time", desc: "Current date and time.", w: 36, h: 22, fields: [
        { key: "timezone", label: "Timezone", type: "select", value: "Europe/London", options: [
          { value: "UTC", label: "GMT / UTC" },
          { value: "Europe/London", label: "London" },
          { value: "Europe/Madrid", label: "Madrid" },
          { value: "America/New_York", label: "New York" },
          { value: "America/Los_Angeles", label: "Los Angeles" },
          { value: "America/Mexico_City", label: "Mexico City" },
          { value: "Asia/Tokyo", label: "Tokyo" },
          { value: "Australia/Sydney", label: "Sydney" }
        ] },
        { key: "label", label: "Label", placeholder: "Current UK Time", value: "Current UK Time" }
      ] },
      { id: "custom-countdown", file: "custom-countdown.html", title: "Custom Countdown", desc: "Fully customizable countdown.", w: 56, h: 32, fields: [
        { key: "text", label: "Top text", placeholder: "Event Starts In", value: "Event Starts In" },
        { key: "size", label: "Size", type: "select", value: "medium", options: [
          { value: "small", label: "Small" },
          { value: "medium", label: "Medium" },
          { value: "large", label: "Large" }
        ] },
        { key: "date", label: "Target date and time", type: "datetime-local" }
      ] }
    ]
  }
];
