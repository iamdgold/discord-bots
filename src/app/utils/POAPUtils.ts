import { GuildChannel, GuildMember, MessageAttachment } from 'discord.js';
import { Collection, Collection as MongoCollection, Cursor, Db, UpdateWriteOpResult } from 'mongodb';
import constants from '../service/constants/constants';
import { POAPParticipant } from '../types/poap/POAPParticipant';
import axios from 'axios';
import ValidationError from '../errors/ValidationError';
import { POAPAdmin } from '../types/poap/POAPAdmin';
import Log, { LogUtils } from './Log';
import dayjs, { Dayjs } from 'dayjs';
import DateUtils from './DateUtils';

export type POAPFileParticipant = {
	id: string,
	tag: string,
	duration: number
};

export type FailedPOAPAttendee = {
	discordUserId: string,
	discordUserTag: string,
	poapLink: string,
}

const POAPUtils = {
	
	async getListOfParticipants(db: Db, voiceChannel: GuildChannel): Promise<POAPFileParticipant[]> {
		const poapParticipants: MongoCollection = db.collection(constants.DB_COLLECTION_POAP_PARTICIPANTS);
		const resultCursor: Cursor<POAPParticipant> = await poapParticipants.find({
			voiceChannelId: voiceChannel.id,
			discordServerId: voiceChannel.guild.id,
		});

		if ((await resultCursor.count()) === 0) {
			Log.debug(`no participants found for ${voiceChannel.name} in ${voiceChannel.guild.name}`);
			return [];
		}
		
		await POAPUtils.setEndDateForPresentParticipants(poapParticipants, resultCursor);

		const participants = [];
		await resultCursor.forEach((participant: POAPParticipant) => {
			const endTime = new Date(participant.endTime).getTime();
			let durationInMinutes: number = (endTime - (new Date(participant.startTime)).getTime());
			durationInMinutes = (durationInMinutes <= 0) ? 0 : durationInMinutes / (1000 * 60);
			if (durationInMinutes >= constants.POAP_REQUIRED_PARTICIPATION_DURATION) {
				participants.push({
					id: participant.discordUserId,
					tag: participant.discordUserTag,
					duration: durationInMinutes,
				});
			}
		});
		return participants;
	},
	
	async setEndDateForPresentParticipants(poapParticipantsCollection: MongoCollection, poapParticipantsCursor: Cursor<POAPParticipant>): Promise<void> {
		Log.debug('starting to set endDate for present participants in db');
		const currentDateStr = dayjs().toISOString();
		for await (const participant of poapParticipantsCursor) {
			if (participant.endTime != null) {
				// skip setting endDate for present endTime;
				continue;
			}
			let result: UpdateWriteOpResult;
			try {
				result = await poapParticipantsCollection.updateOne(participant, {
					$set: {
						endTime: currentDateStr,
					},
				});
			} catch (e) {
				LogUtils.logError('failed to update poap participants with endTime', e);
			}
			if (result == null) {
				throw new Error('Mongodb operation failed');
			}
		}
		Log.debug('finished setting endDate for present participants in db');
	},

	async sendOutPOAPLinks(guildMember: GuildMember, listOfParticipants: POAPFileParticipant[], attachment: MessageAttachment, event?: string): Promise<FailedPOAPAttendee[]> {
		let listOfPOAPLinks;
		const failedPOAPsList: FailedPOAPAttendee[] = [];
		const guildName = guildMember.guild.name;
		event = (event == null) ? 'event' : event;
		try {
			const response = await axios.get(attachment.url);
			listOfPOAPLinks = response.data.split('\n');
		} catch (e) {
			LogUtils.logError('failed to process links.txt file', e);
			await guildMember.send({ content: 'Could not process the links.txt file. Please make sure the file that is uploaded has every URL on a new line.' });
			return;
		}
		for (let i = 0; i < listOfParticipants.length; i++) {
			try {
				if (listOfPOAPLinks[i] == null || listOfPOAPLinks[i] == '') {
					failedPOAPsList.push({
						discordUserId: listOfParticipants[i].id,
						discordUserTag: listOfParticipants[i].tag,
						poapLink: 'n/a',
					});
					continue;
				}
				await guildMember.guild.members.fetch(listOfParticipants[i].id)
					.then(async (participantMember: GuildMember) => {
						await participantMember.send({ content: `Thank you for participating in the ${event} from ${guildName}! Here is your POAP: ${listOfPOAPLinks[i]}` }).catch((e) => {
							failedPOAPsList.push({
								discordUserId: listOfParticipants[i].id,
								discordUserTag: listOfParticipants[i].tag,
								poapLink: listOfPOAPLinks[i],
							});
							LogUtils.logError(`failed trying to send POAP to: ${listOfParticipants[i].id}, userTag: ${listOfParticipants[i].tag}, link: ${listOfPOAPLinks[i]}`, e);
						});
					}).catch(async (e) => {
						LogUtils.logError(`failed trying to find: ${listOfParticipants[i].id}, userTag: ${listOfParticipants[i].tag}, to give link ${listOfPOAPLinks[i]}`, e);
						const tryAgainMember: GuildMember = await guildMember.guild.members.fetch(listOfParticipants[i].id);
						Log.debug(`trying to send another message to user ${listOfParticipants[i].tag}`);
						await tryAgainMember.send({ content: `Thank you for participating in the ${event} from ${guildName}! Here is your POAP: ${listOfPOAPLinks[i]}` }).catch((e2) => {
							failedPOAPsList.push({ discordUserId: listOfParticipants[i].id, discordUserTag: listOfParticipants[i].tag, poapLink: listOfPOAPLinks[i] });
							LogUtils.logError(`failed trying to send POAP to: ${listOfParticipants[i].id}, userTag: ${listOfParticipants[i].tag}, link: ${listOfPOAPLinks[i]}`, e2);
						});
					});
			} catch (e) {
				LogUtils.logError('user might have been banned', e);
				failedPOAPsList.push({ discordUserId: listOfParticipants[i].id, discordUserTag: listOfParticipants[i].tag, poapLink: listOfPOAPLinks[i] });
			}
		}
		Log.info(`Links sent to ${listOfParticipants.length} participants.`);
		return failedPOAPsList;
	},

	async validateEvent(guildMember: GuildMember, event?: string): Promise<any> {
		if (event == null) {
			return;
		}
		const POAP_EVENT_REGEX = /^[\w\s\W]{1,250}$/;
		if (!POAP_EVENT_REGEX.test(event)) {
			await guildMember.send({
				content: `<@${guildMember.user.id}>\n` +
					'Please enter a valid event: \n' +
					'- 250 characters maximum\n ' +
					'- alphanumeric\n ' +
					'- special characters: .!@#$%&,?',
			});
			throw new ValidationError('Please try another event.');
		}
	},
	
	async validateNumberToMint(guildMember: GuildMember, numberToMint: number): Promise<any> {
		if (numberToMint >= 1000 || numberToMint <= 0) {
			await guildMember.send({
				content: `<@${guildMember.user.id}>\n` +
					'A maximum of 1000 POAPs can be minted for a single event. Please let us know if you\'d like to see this increased. ',
			});
			throw new ValidationError('Please try another mint value.');
		}
	},

	async validateDuration(guildMember: GuildMember, duration?: number): Promise<any> {
		if (duration == null) {
			return;
		}
		if (duration > constants.POAP_MAX_DURATION_MINUTES || duration < constants.POAP_REQUIRED_PARTICIPATION_DURATION) {
			await guildMember.send({
				content: `<@${guildMember.user.id}>\n` +
					`A minimum of ${constants.POAP_REQUIRED_PARTICIPATION_DURATION} minutes is required for an event to be active and no more than ${constants.POAP_MAX_DURATION_MINUTES} minutes.`,
			});
			throw new ValidationError(`Please try a value greater than ${constants.POAP_REQUIRED_PARTICIPATION_DURATION} and less than ${constants.POAP_MAX_DURATION_MINUTES} minutes.`);
		}
	},
	
	async validateUserAccess(guildMember: GuildMember, db: Db): Promise<any> {
		const poapAdminsDb: Collection = await db.collection(constants.DB_COLLECTION_POAP_ADMINS);
		const userResult: POAPAdmin = await poapAdminsDb.findOne({
			objectType: 'USER',
			discordObjectId: guildMember.user.id,
			discordServerId: guildMember.guild.id,
		});
		if (userResult != null) {
			// user has access
			return;
		}
		const rolesCursor: Cursor<POAPAdmin> = await poapAdminsDb.find({
			objectType: 'ROLE',
			discordServerId: guildMember.guild.id,
		});
		for await (const poapRole of rolesCursor) {
			if (guildMember.roles.cache.some(role => role.id === poapRole.discordObjectId)) {
				// role has access
				return;
			}
		}
		throw new ValidationError('Only authorized users can use this command. Please reach out to an admin for configuration help.');
	},
	
	getDateString(date: Dayjs): string {
		return date.format('MM-DD-YYYY');
	},
	
	getExpiryDate(date: string): string {
		try {
			const dateObject: Dayjs = DateUtils.getDate(date);
			return dateObject.add(1, 'month').format('MM-DD-YYYY');
		} catch (e) {
			LogUtils.logError('failed to parse expiry date', e);
			throw new Error('processing failed');
		}
	},
	
	getEventYear(startDateObj: Dayjs): string {
		return startDateObj.year().toString();
	},
};

export default POAPUtils;