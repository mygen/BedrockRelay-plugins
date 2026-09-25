/**
 * Skin — a BedrockRelay plugin.
 * /skin [gamertag] shows a player's skin, rendered by MinecraftRender.
 *
 * The Minecraft server makes no request: the answer is only a link to the
 * render, and Discord fetches the picture itself. The player needn't be online.
 */

const RENDER = "https://minecraftrender.com/api/render";
const POSE = "kwfb01";

export default {
  id: "skin",
  name: "Skin",
  version: "1.0.2",
  description: "Show any Bedrock player's skin, rendered by MinecraftRender.",
  commands: [
    {
      name: "skin",
      description: "Show a player's skin",
      public: true,
      options: [{ name: "gamertag", type: "player", description: "Their Xbox gamertag (leave empty for you, once you've used /relay link)", required: false }],
      run({ gamertag: typed }, { linkedPlayer }) {
        // Bedrock gamertags go to MinecraftRender with a "." in front; accept one typed by hand too.
        const name = (typed ?? linkedPlayer ?? "").trim().replace(/^\./, "");
        if (!name) return "Say whose skin, or link your own with `/relay link` so this knows who you are.";
        if (name.length > 32) return "That's too long to be a gamertag.";
        const imageUrl = `${RENDER}/${encodeURIComponent(`.${name}`)}/${POSE}.png`;

        return {
          embed: {
            color: 0x5865f2,
            title: `${name}'s skin`,
            url: imageUrl,
            image: { url: imageUrl },
            footer: { text: "Rendered by MinecraftRender" },
          },
        };
      },
    },
  ],
};
