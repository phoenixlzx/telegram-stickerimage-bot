#!/bin/env node
'use strict';

var config = require('./config.js');

var fs = require('fs-extra');
var path = require('path');

var TelegramBot = require('node-telegram-bot-api');
var im = require('imagemagick');
var JSZip = require("jszip");
var async = require('async');

var token = config.token;
var bot = new TelegramBot(token, {polling: true});
im.convert.path = config.im_convert_path;

var messages = JSON.parse(fs.readFileSync(path.resolve('./lang/' + config.lang + '.json'), 'utf8'));

var ramdb = {};
// check storage path
var fspath = path.resolve(config.file_storage);
fs.stat(fspath, function(err, stats) {
    if (err && err.code === 'ENOENT') {
        console.log(messages.app.storagepathnotexist);
        fs.mkdirpSync(fspath);
    }
});

bot.onText(/\/newpack*/i, function (msg) {
    var chatId = msg.chat.id;
    ramdb[chatId] = {
        start: msg.date,
        files: [],
        srcimg: [],
        destimg: []
    };
    bot.sendMessage(chatId, messages.msg.newpack.replace('%max%', config.maximages));
});

bot.onText(/\/finish\s?(png)?\s?(\d+)?/i, function (msg, match) {
    var chatId = msg.chat.id;
    var format = match[1];
    var width = match[2];
    if (ramdb[chatId] && ramdb[chatId].files.length > 0) {
        console.log('[' + chatId + '] Starting pack task...');
        var packpath = config.file_storage + '/' + chatId,
            srcpath = packpath + '/src/',
            imgpath = packpath + '/img/';
        fs.mkdirpSync(path.resolve(packpath));
        fs.mkdirpSync(path.resolve(srcpath));
        fs.mkdirpSync(path.resolve(imgpath));
        async.series([
            function (cb) {
                console.log('[' + chatId + '] Downloading files...');
                bot.sendMessage(chatId, messages.msg.downloading);
                async.eachSeries(ramdb[chatId].files, function (fileId, callback) {
                    bot.downloadFile(fileId, path.resolve(srcpath))
                            .then(function (srcimg) {
                                console.log('[' + chatId + '] File ' + fileId + ' saved to disk.');
                                ramdb[chatId].srcimg.push(srcimg);
                                callback();
                            });
                    }, function () {
                        cb();
                    });
            },
            function (cb) {
                console.log('[' + chatId + '] Converting images...');
                bot.sendMessage(chatId, messages.msg.converting);
                async.eachSeries(ramdb[chatId].srcimg, function (src, callback) {
                    var imarg = [src];
                    var destimg = path.resolve(imgpath + '/' + path.basename(src, 'webp') + 'jpg');
                    if (width && width < 512) {
                        imarg.push('-resize', width + 'x' + width);
                    }
                    if (format === 'png') {
                        destimg = path.resolve(imgpath + '/' + path.basename(src, 'webp') + 'png');
                        imarg.push(destimg);
                    } else {
                        // use -flatten to add white background to jpg files
                        imarg.push('-flatten', destimg)
                    }
                    console.log('[' + chatId + '] Convert command:', im.convert.path, imarg.join(' '));
                    im.convert(imarg, function (err, stdout) {
                        ramdb[chatId].destimg.push(destimg);
                        callback(err);
                    });
                }, function (err) {
                    if (err) {
                        bot.sendMessage(chatId, messages.msg.error);
                        return cleanup(chatId);
                    }
                    cb();
                });
            },
            function (cb) {
                bot.sendMessage(chatId, messages.msg.packaging);
                console.log('[' + chatId + '] Adding files to package...');
                var zip = new JSZip();
                ramdb[chatId].srcimg.forEach(function (src) {
                    var fname = chatId + '/src/' + path.basename(src);
                    console.log('[' + chatId + '] Adding file ', fname);
                    zip.file(fname, fs.readFileSync(path.resolve(src)));
                });
                ramdb[chatId].destimg.forEach(function (dest) {
                    var fname = chatId + '/img/' + path.basename(dest);
                    console.log('[' + chatId + '] Adding file ', fname);
                    zip.file(fname, fs.readFileSync(path.resolve(dest)));
                });
                console.log('[' + chatId + '] Packaging files...');
                zip.generateAsync({
                    compression: 'DEFLATE',
                    type: 'nodebuffer',
                    comment: 'Created by stickerimagebot',
                    platform: process.platform
                })
                    .then(function (content) {
                        cb(null, content);
                    });
            }],
            function (err, res) {
                bot.sendMessage(chatId, messages.msg.sending);
                bot.sendDocument(chatId, res[2]);
                console.log('[' + chatId + '] Sending zip file...');
                // clear task
                cleanup(chatId);
                console.log('[' + chatId + '] Task finished.');
            }
        );
    } else {
        bot.sendMessage(chatId, messages.msg.nosticker);
    }
});

bot.on('message', function (msg) {
    var chatId = msg.chat.id;

    if (msg.sticker && ramdb[chatId]) {
        ramdb[chatId].files.push(msg.sticker.file_id);
        bot.sendMessage(chatId, messages.msg.saved.replace('%remain%', config.maximages - ramdb[chatId].files.length));
    } else {
        if (!/(\/(finish|newpack))/i.exec(msg.text)) {
            bot.sendMessage(chatId, messages.msg.start);
        }
    }
});

function cleanup(id) {
    console.log('[' + id + '] Cleaning up...');
    ramdb[id] = undefined;
    fs.removeSync(path.resolve(config.file_storage + '/' + id));
}
