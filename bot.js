#!/usr/bin/env node
'use strict';

const config = require('./config.js');

const fs = require('fs-extra');
const path = require('path');

const { Telegraf } = require('telegraf');
const sharp = require('sharp');
const JSZip = require('jszip');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');

const bot = new Telegraf(config.token);

let messages = {};
loadLang();

let ramdb = {};
let langSession = {};

bot.use((ctx, next) => {
    if (ctx.message && !langSession[ctx.message.chat.id]) {
        langSession[ctx.message.chat.id] = config.default_lang;
    }
    return next();
});

// Check storage path
let fspath = path.resolve(config.file_storage);
if (!fs.existsSync(fspath)) {
    logger('INTERNAL', 'info', messages[config.default_lang].app.storagepathnotexist);
    fs.mkdirpSync(fspath);
}

bot.catch((err) => {
    logger('INTERNAL', 'error', err);
});

bot.command('lang', (ctx) => {
    i18nHandler(ctx);
});

bot.command('newpack', (ctx) => {
    let chatId = ctx.message.chat.id;
    if (ramdb[chatId] && ramdb[chatId].islocked) {
        return ctx.reply(messages[langSession[chatId]].msg.tasklocked);
    }
    if (ramdb[chatId] && ramdb[chatId].files.length > 0) {
        return ctx.reply(messages[langSession[chatId]].msg.taskexist);
    }
    newPackHandler(ctx, () => {
        return ctx.reply(messages[langSession[chatId]].msg.newpack.replace('%max%', config.maximages));
    });
});

bot.command('finish', async (ctx) => {
    let chatId = ctx.message.chat.id;
    if (ramdb[chatId] && ramdb[chatId].islocked) {
        return ctx.reply(messages[langSession[chatId]].msg.tasklocked);
    }
    let args = ctx.message.text.split(' ').slice(1).join(' ').trim();
    let format = args === 'png' ? 'png' : 'jpg'; // Default to 'jpg' if no 'png' parameter is provided
    if (ramdb[chatId] && ramdb[chatId].files.length > 0) {
        await finishHandler(ctx, format);
    } else {
        ctx.reply(messages[langSession[chatId]].msg.nosticker);
    }
});

bot.command('sources', (ctx) => {
    sourcesHandler(ctx);
});

bot.command('cancel', (ctx) => {
    cancellationHandler(ctx);
});

bot.on('message', (ctx) => {
    generalMsgHandler(ctx);
});

bot.launch();

async function errMsgHandler(ctx, err) {
    let chatId = ctx.message.chat.id;
    if (err) {
        await ctx.reply(messages[langSession[chatId]].msg.errmsg
            .replace('%errcode%', err.code || '')
            .replace('%errbody%', err.response?.body || err.message));
    } else {
        await ctx.reply(messages[langSession[chatId]].msg.error);
    }
    return cleanup(chatId);
}

function newPackHandler(ctx, callback) {
    let chatId = ctx.message.chat.id;
    logger(chatId, 'info', 'Started a new pack task.');
    ramdb[chatId] = {
        start: ctx.message.date,
        files: [],
        srcimg: [],
        destimg: [],
        islocked: false
    };
    callback();
}

async function finishHandler(ctx, format) {
    try {
        let chatId = ctx.message.chat.id;
        logger(chatId, 'info', 'Starting pack task...');
        ramdb[chatId].islocked = true;
        let fpath = {
            packpath: path.join(config.file_storage, chatId.toString())
        };
        fpath['srcpath'] = path.join(fpath.packpath, 'src');
        fpath['imgpath'] = path.join(fpath.packpath, 'img');
        fs.mkdirpSync(fpath.packpath);
        fs.mkdirpSync(fpath.srcpath);
        fs.mkdirpSync(fpath.imgpath);

        await ctx.reply(messages[langSession[chatId]].msg.downloading);
        await downloadHandler(ctx, fpath);

        await ctx.reply(messages[langSession[chatId]].msg.converting);
        await convertHandler(ctx, fpath, format);

        await ctx.reply(messages[langSession[chatId]].msg.packaging);

        // Batch images and send ZIP files
        await batchAndSendZipFiles(ctx, fpath);

        cleanup(chatId);
        logger(chatId, 'info', 'Task finished.');
    } catch (err) {
        errMsgHandler(ctx, err);
    }
}

async function batchAndSendZipFiles(ctx, fpath) {
    let chatId = ctx.message.chat.id;
    let files = ramdb[chatId].destimg;
    let batches = [];
    let currentBatch = [];
    let currentBatchSize = 0;

    // Batch images based on file sizes
    for (let file of files) {
        let fileSize = fs.statSync(file).size;
        if (currentBatchSize + fileSize > config.maxfilebytes && currentBatch.length > 0) {
            batches.push(currentBatch);
            currentBatch = [];
            currentBatchSize = 0;
        }
        currentBatch.push(file);
        currentBatchSize += fileSize;
    }

    // Add the last batch if it has any files
    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }

    logger(chatId, 'info', `Total batches to send: ${batches.length}`);

    // Send each batch as a ZIP file
    for (let i = 0; i < batches.length; i++) {
        let batch = batches[i];
        let zipFilePath = await createZipForBatch(ctx, fpath, batch, i + 1);

        await ctx.telegram.sendDocument(ctx.from.id, {
            source: fs.createReadStream(zipFilePath),
            filename: `stickers_${chatId}_${i + 1}.zip`
        });

        // Clean up the sent files and ZIP
        fs.unlinkSync(zipFilePath);
        for (let file of batch) {
            fs.unlinkSync(file);
        }

        logger(chatId, 'info', `Sent batch ${i + 1} and cleaned up.`);
    }
}

async function createZipForBatch(ctx, fpath, batchFiles, batchNumber) {
    let chatId = ctx.message.chat.id;
    let zip = new JSZip();

    for (let file of batchFiles) {
        let fname = path.basename(file);
        logger(chatId, 'info', `Adding file ${fname} to batch ${batchNumber}`);
        zip.file(fname, fs.readFileSync(file));
    }

    let zipContent = await zip.generateAsync({
        compression: 'DEFLATE',
        type: 'nodebuffer',
        comment: 'Created by telegram-stickerimage-bot',
        platform: process.platform
    });

    let zipFilePath = path.join(fpath.packpath, `stickers_${chatId}_${batchNumber}.zip`);
    fs.writeFileSync(zipFilePath, zipContent);

    return zipFilePath;
}

function cancellationHandler(ctx) {
    let chatId = ctx.message.chat.id;
    if (!ramdb[chatId]) {
        return ctx.reply(messages[langSession[chatId]].msg.notask);
    }
    delete ramdb[chatId];
    cleanup(chatId);
    logger(chatId, 'info', 'Task Cancelled.');
    return ctx.reply(messages[langSession[chatId]].msg.taskcancelled);
}

function sourcesHandler(ctx) {
    let chatId = ctx.message.chat.id;
    return ctx.reply(messages[langSession[chatId]].msg.supported_sticker_sources.replace('%sources%', config.sticker_sources.reduce((x, c) => `${x}\n${c}`)));
}

function generalMsgHandler(ctx) {
    let chatId = ctx.message.chat.id;
    if (ctx.chat.type !== 'private') return;
    if (ramdb[chatId] && !ramdb[chatId].islocked) {
        if (ctx.message.sticker) {
            addSticker(ctx);
        }
        if (ctx.message.entities) {
            ctx.message.entities.forEach((e) => {
                if (e.type === 'url') {
                    let url = ctx.message.text.slice(e.offset, e.offset + e.length);
                    if (config.sticker_sources.find((x) => url.startsWith(x)) &&
                        url.length > 25) {
                        stickerSetHandler(ctx, path.basename(url));
                    } else {
                        ctx.reply(messages[langSession[chatId]].msg.unsupported_sticker_source.replace('%source%', url));
                    }
                }
            });
        }
    } else if (!ramdb[chatId] && ctx.message.sticker) {
        directHandler(ctx);
    } else {
        ctx.reply((ramdb[chatId] && ramdb[chatId].islocked) ?
            messages[langSession[chatId]].msg.tasklocked :
            messages[langSession[chatId]].msg.start);
    }
}

function i18nHandler(ctx) {
    let chatId = ctx.message.chat.id;
    let chosen_lang = ctx.message.text.split(' ').slice(1).join('').trim();
    if (config.available_lang.hasOwnProperty(chosen_lang)) {
        langSession[chatId] = chosen_lang;
        logger(chatId, 'info', 'Changing language to: ' + chosen_lang);
        return ctx.reply(messages[langSession[chatId]].msg.language_change);
    }
    let message = messages[langSession[chatId]].msg.language_available;
    let languages_names = '';
    for (let k in config.available_lang) {
        if (config.available_lang.hasOwnProperty(k)) {
            languages_names += '\n' + '[' + k + '] ' + config.available_lang[k].join(' / ');
        }
    }
    return ctx.reply(message.replace('%languages%', languages_names));
}

async function downloadHandler(ctx, fpath) {
    let chatId = ctx.message.chat.id;
    logger(chatId, 'info', 'Downloading files...');
    for (let fileId of ramdb[chatId].files) {
        try {
            let { url, ext } = await resolveFile(ctx, fileId);
            let destFile = path.join(fpath.srcpath, fileId + ext);
            await download(url, destFile);
            logger(chatId, 'info', 'File ' + fileId + ' saved to disk.');
            ramdb[chatId].srcimg.push(destFile);
        } catch (err) {
            logger(chatId, 'error', 'Error downloading file ' + fileId + ': ' + err);
        }
    }
}

async function convertHandler(ctx, fpath, format) {
    let chatId = ctx.message.chat.id;
    logger(chatId, 'info', 'Converting images...');
    for (let src of ramdb[chatId].srcimg) {
        try {
            let dest = await convert(ctx, src, fpath, format);
            ramdb[chatId].destimg.push(dest);
        } catch (err) {
            logger(chatId, 'error', 'Error converting file ' + src + ': ' + err);
        }
    }
}

async function zipHandler(ctx) {
    let chatId = ctx.message.chat.id;
    logger(chatId, 'info', 'Adding files to ZIP file...');
    let zip = new JSZip();
    for (let src of ramdb[chatId].srcimg) {
        let fname = path.join(chatId.toString(), 'src', path.basename(src));
        logger(chatId, 'info', 'Adding file ' + fname);
        zip.file(fname, fs.readFileSync(src));
    }
    for (let dest of ramdb[chatId].destimg) {
        let fname = path.join(chatId.toString(), 'img', path.basename(dest));
        logger(chatId, 'info', 'Adding file ' + fname);
        zip.file(fname, fs.readFileSync(dest));
    }
    logger(chatId, 'info', 'Packaging files...');
    let content = await zip.generateAsync({
        compression: 'DEFLATE',
        type: 'nodebuffer',
        comment: 'Created by telegram-stickerimage-bot',
        platform: process.platform
    });
    return content;
}

function stickerSetHandler(ctx, setName) {
    let chatId = ctx.message.chat.id;
    ctx.reply(messages[langSession[chatId]].msg.get_set_info);
    bot.telegram.getStickerSet(setName)
        .then((set) => {
            if (ramdb[chatId].files.length + set.stickers.length >= config.maximages) {
                return ctx.reply(messages[langSession[chatId]].msg.taskfull);
            }
            logger(chatId, 'info', 'Adding Sticker Set: ' + setName);
            addSet(ctx, set);
        })
        .catch((err) => {
            logger(chatId, 'error', 'Error Adding Sticker Set: ' + setName + ': ' + err);
            ctx.reply(messages[langSession[chatId]].msg.invalid_set.replace('%setName%', setName));
        });
}

async function directHandler(ctx) {
    let chatId = ctx.message.chat.id;
    let messageId = ctx.message.message_id;
    let format = 'jpg'; // Default format
    newPackHandler(ctx, () => { });
    ramdb[chatId].islocked = true;
    let fpath = {
        packpath: path.join(config.file_storage, chatId.toString())
    };
    fpath['srcpath'] = path.join(fpath.packpath, 'src');
    fpath['imgpath'] = path.join(fpath.packpath, 'img');
    fs.mkdirpSync(fpath.packpath);
    fs.mkdirpSync(fpath.srcpath);
    fs.mkdirpSync(fpath.imgpath);
    logger(chatId, 'info', 'Started direct image task.');
    let pendingMsg = await ctx.reply(messages[langSession[chatId]].msg.direct_task_started);
    try {
        let { url, ext } = await resolveFile(ctx, ctx.message.sticker.file_id);
        let destFile = path.join(fpath.srcpath, ctx.message.sticker.file_id + ext);
        await download(url, destFile);
        // Determine format based on sticker type
        if (ctx.message.sticker.is_animated || ctx.message.sticker.is_video) {
            format = 'gif';
        }
        let outputFile = await convert(ctx, destFile, fpath, format);
        // Send the file as a document with disable_content_type_detection, though, doesn't seem to work
        await ctx.replyWithDocument({
            source: fs.createReadStream(outputFile),
            filename: path.basename(outputFile)
        }, {
            reply_to_message_id: messageId,
            disable_content_type_detection: true
        });
        await ctx.deleteMessage(pendingMsg.message_id);
        cleanup(chatId);
    } catch (err) {
        cleanup(chatId);
        logger(chatId, 'error', 'Error direct image task:' + err);
        await ctx.reply(
            messages[langSession[chatId]].msg.error,
            { reply_to_message_id: messageId }
        );
    }
}

function addSticker(ctx) {
    let chatId = ctx.message.chat.id;
    if (ramdb[chatId].files.includes(ctx.message.sticker.file_id)) {
        return ctx.reply(messages[langSession[chatId]].msg.duplicated_sticker, { reply_to_message_id: ctx.message.message_id });
    }
    if (ramdb[chatId].files.length >= config.maximages) {
        return ctx.reply(messages[langSession[chatId]].msg.taskfull);
    }
    ramdb[chatId].files.push(ctx.message.sticker.file_id);
    let remain = config.maximages - ramdb[chatId].files.length;
    ctx.reply(remain === 0 ?
        messages[langSession[chatId]].msg.taskfull :
        messages[langSession[chatId]].msg.saved.replace('%remain%', remain));
}

function addSet(ctx, set) {
    let chatId = ctx.message.chat.id;
    let originCount = ramdb[chatId].files.length;
    set.stickers.forEach((s) => {
        if (!ramdb[chatId].files.includes(s.file_id)) {
            ramdb[chatId].files.push(s.file_id);
        }
    });
    ctx.reply(messages[langSession[chatId]].msg.set_added_count
        .replace('%sticker_count%', ramdb[chatId].files.length - originCount));
}

async function resolveFile(ctx, fileId) {
    let chatId = ctx.message.chat.id;
    try {
        let file = await ctx.telegram.getFile(fileId);
        let url = `https://api.telegram.org/file/bot${config.token}/${file.file_path}`;
        let ext = path.extname(file.file_path) || '';
        return { url, ext };
    } catch (err) {
        await ctx.reply(
            messages[langSession[chatId]].msg.err_get_filelink.replace('%fileId%', fileId)
        );
        logger(chatId, 'error', 'Get File Link for ' + fileId + ': ' + err);
        throw err;
    }
}

async function download(url, dest) {
    const response = await axios({
        method: 'get',
        url: url,
        responseType: 'stream',
    });
    const writer = fs.createWriteStream(dest);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', (err) => {
            fs.unlink(dest, () => { });
            reject(err);
        });
    });
}

async function convert(ctx, src, fpath, format) {
    let chatId = ctx.message.chat.id;
    let destimg;
    let width = 512; // Default width
    let ext = path.extname(src).toLowerCase();

    if (ext === '.tgs' || ext === '.webm') {
        // Animated sticker, convert to GIF regardless of the format parameter
        destimg = path.join(fpath.imgpath, path.basename(src, ext) + '.gif');
        if (ext === '.tgs') {
            await convertTgsToGif(src, destimg, width);
        } else {
            await convertWebmToGif(src, destimg, width);
        }
    } else {
        // Static image, convert based on the format parameter (jpg or png)
        destimg = path.join(fpath.imgpath, path.basename(src, ext) + '.' + format);
        await convertImage(src, destimg, width, format);
    }

    return destimg;
}

async function convertWebmToGif(src, dest, width) {
    return new Promise((resolve, reject) => {
        ffmpeg(src)
            .outputOptions([
                '-vf', `scale=${width}:-1:flags=lanczos`,
                '-y'
            ])
            .toFormat('gif')
            .save(dest)
            .on('end', resolve)
            .on('error', reject);
    });
}

async function convertTgsToGif(src, dest, width) {
    const fs = require('fs-extra');
    const path = require('path');
    const { exec } = require('child_process');

    // Define paths
    const jsonPath = src + '.json';

    // Decompress the .tgs file to JSON
    await new Promise((resolve, reject) => {
        const command = `gzip -dc "${src}" > "${jsonPath}"`;
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error decompressing .tgs file: ${stderr}`);
                reject(error);
            } else {
                resolve();
            }
        });
    });

    // Use lottie2gif to convert JSON to GIF
    await new Promise((resolve, reject) => {
        const command = `${config.lottie2gif} -o "${dest}" "${jsonPath}"`;
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error converting JSON to GIF: ${stderr}`);
                reject(error);
            } else {
                resolve();
            }
        });
    });

    // Clean up the temporary JSON file
    fs.unlinkSync(jsonPath);
}

async function convertImage(src, dest, width, format) {
    let image = sharp(src);
    if (width && width < 512) {
        image = image.resize(width, width, { fit: 'inside' });
    }
    if (format === 'png') {
        await image.toFile(dest);
    } else {
        await image.flatten({ background: '#FFFFFF' }).jpeg().toFile(dest);
    }
}

function cleanup(id) {
    logger(id, 'info', 'Cleaning up...');
    delete ramdb[id];
    fs.removeSync(path.resolve(config.file_storage, id.toString()));
}

function loadLang() {
    for (let k in config.available_lang) {
        if (config.available_lang.hasOwnProperty(k)) {
            messages[k] = JSON.parse(fs.readFileSync(path.resolve('./lang/' + k + '.json'), 'utf8'));
            logger('INTERNAL', 'info', 'Loaded language strings: ' + k);
        }
    }
}

function logger(chatId, type, msg) {
    console.log('[' + chatId + ']', '[' + type.toUpperCase() + ']', msg);
}
