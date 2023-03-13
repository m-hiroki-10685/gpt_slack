import { WebClient } from '@slack/web-api';
import { Configuration, OpenAIApi, ChatCompletionRequestMessageRoleEnum } from "openai";
import axios from 'axios';

const openaiConfig = new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
});
const openaiClient = new OpenAIApi(openaiConfig);
const botTokens = {
    process.env.WORKSPACE_ID: process.env.SLACK_BOT_TOKEN,
};
const slackClient = (team_id) => {
    const bot_token = botTokens[team_id];
    return new WebClient(bot_token);
};

export const handler = async (event, context) => {
    console.log('event: ', event);
    if (event.headers['x-slack-retry-num']) {
        return { statusCode: 200, body: JSON.stringify({ message: "No need to resend" }) };
    }

    console.log('event.headers:', event.headers);
    console.log('event.body:', event.body);

    const body = JSON.parse(event.body);
    const team_id = body.team_id;
    const web = slackClient(team_id);//ワークスペース毎に切り替え
    const text = body.event.text.replace(/<@.*>/g, "");
    const thread_ts = body.event.thread_ts || body.event.ts;
    console.log('input: ', text);

    // Slackのメッセージに[ai_img]が含まれていれば、テキストから画像を生成する
    if (text.includes('[ai_img]')) {
        const imageUrl = await generateImage(text.replace('[ai_img]', ''));
        console.log('imageUrl:', imageUrl);
        await postImage(web, body.event.channel, imageUrl, thread_ts);
        return { statusCode: 200, body: JSON.stringify({ message: "Image generated successfully." }) };
    }

    // スレッドの履歴を取得する
    let history = await fetchThreadHistory(web, body.event.channel, thread_ts);
    history.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
    history = history.slice(1).slice(-20);
    console.log('history: ', history);

    const prev_message = history.map(m => {
        const role = m.bot_id ? ChatCompletionRequestMessageRoleEnum.Assistant : ChatCompletionRequestMessageRoleEnum.User;
        return { role: role, content: m.text };
    });

    const openaiResponse = await createCompletion(text, prev_message);

    await postMessage(web, body.event.channel, openaiResponse, thread_ts);

    return { statusCode: 200, body: JSON.stringify({ message: openaiResponse }) };
};

async function createCompletion(text, prev_message) {
    try {
        const response = await openaiClient.createChatCompletion({
            model: 'gpt-3.5-turbo',
            messages: [
                {
                    role: ChatCompletionRequestMessageRoleEnum.User,
                    content: `
                    ロールプレイ
                    `,
                },
                {
                    role: ChatCompletionRequestMessageRoleEnum.Assistant,
                    content: `
                    ロールプレイ承認
                    `
                },
                ...prev_message,
                {
                    role: ChatCompletionRequestMessageRoleEnum.User,
                    content: text

                },
            ],
        });
        console.log('openaiResponse: ', response);
        return response.data.choices[0].message?.content;
    } catch (err) {
        console.error(err);
    }
}

async function postMessage(slackClient, channel, text, thread_ts) {
    try {
        let payload = {
            channel: channel,
            text: text,
            as_user: true,
            thread_ts: thread_ts
        };
        const response = await slackClient.chat.postMessage(payload);
        console.log('slackResponse: ', response);
    } catch (err) {
        console.error(err);
    }
}

async function fetchThreadHistory(slackClient, channel, thread_ts) {
    try {
        const response = await slackClient.conversations.replies({
            channel: channel,
            ts: thread_ts,
            oldest: 1,
        });
        return response.messages.reverse();
    } catch (err) {
        console.error(err);
    }
}

async function postImage(slackClient, channel, imageUrl, thread_ts) {
    try {
        // 画像ファイルをダウンロード
        const image = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const imageData = Buffer.from(image.data, 'binary');
        const response = await slackClient.files.upload({
            channels: channel,
            thread_ts: thread_ts,
            file: imageData,
            title: "Generated Image",
            initial_comment: "こちらが画像です",
        });
        console.log('slackResponse: ', response);
    } catch (err) {
        console.error(err);
    }
}

async function generateImage(prompt) {
    const response = await openaiClient.createImage({
        prompt: prompt,
        n: 1,
    });
    const image_url = response.data.data[0].url;
    return image_url;
}

