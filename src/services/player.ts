import AsyncStorage from '@react-native-community/async-storage'
import {
  convertNowPlayingItemClipToNowPlayingItemEpisode,
  convertToNowPlayingItem,
  NowPlayingItem
} from 'podverse-shared'
import { Platform } from 'react-native'
import RNFS from 'react-native-fs'
import TrackPlayer, { Capability, PitchAlgorithm, State, Track } from 'react-native-track-player'
import { getGlobal } from 'reactn'
import { getDownloadedEpisode } from '../lib/downloadedPodcast'
import { BackgroundDownloader } from '../lib/downloader'
import { checkIfIdMatchesClipIdOrEpisodeIdOrAddByUrl,
  getAppUserAgent, getExtensionFromUrl } from '../lib/utility'
import { PV } from '../resources'
import PVEventEmitter from './eventEmitter'
import { getPodcastCredentialsHeader } from './parser'
import { getPodcastFeedUrlAuthority } from './podcast'
import {
  addQueueItemLast,
  addQueueItemNext,
  filterItemFromQueueItems,
  getQueueItems,
  getQueueItemsLocally
} from './queue'
import { addOrUpdateHistoryItem, getHistoryItemsIndexLocally, getHistoryItemsLocally } from './userHistoryItem'
import { getNowPlayingItem, getNowPlayingItemLocally } from './userNowPlayingItem'

declare module "react-native-track-player" {
  export function getCurrentLoadedTrack(): Promise<string>;
  export function getTrackDuration(): Promise<number>;
  export function getTrackPosition(): Promise<number>;
}

export const PVTrackPlayer = TrackPlayer

const checkServiceRunning = async (defaultReturn: any = '') => {
  try {
    const serviceRunning = await PVTrackPlayer.isServiceRunning()
    if (!serviceRunning) {
      throw new Error('PVTrackPlayer Service not running')
    }
  } catch (err) {
    console.log(err.message)
    return defaultReturn
  }

  return true
}

PVTrackPlayer.getTrackPosition = async () => {
  const serviceRunningResult = await checkServiceRunning(0)

  if (serviceRunningResult !== true) {
    return serviceRunningResult
  }

  return PVTrackPlayer.getPosition()
}

PVTrackPlayer.getCurrentLoadedTrack = async () => {
  const serviceRunningResult = await checkServiceRunning()

  if (serviceRunningResult !== true) {
    return serviceRunningResult
  }

  return PVTrackPlayer.getCurrentTrack()
}

PVTrackPlayer.getTrackDuration = async () => {
  const serviceRunningResult = await checkServiceRunning(0)
  if (serviceRunningResult !== true) {
    return serviceRunningResult
  }

  return PVTrackPlayer.getDuration()
}

// TODO: setupPlayer is a promise, could this cause an async issue?
PVTrackPlayer.setupPlayer({
  waitForBuffer: false
}).then(() => {
  updateTrackPlayerCapabilities()
})

export const updateTrackPlayerCapabilities = () => {
  const { jumpBackwardsTime, jumpForwardsTime } = getGlobal()

  PVTrackPlayer.updateOptions({
    capabilities: [
      Capability.JumpBackward,
      Capability.JumpForward,
      Capability.Pause,
      Capability.Play,
      Capability.SeekTo,
      Capability.SkipToNext,
      Capability.SkipToPrevious
    ],
    compactCapabilities: [
      Capability.JumpBackward,
      Capability.JumpForward,
      Capability.Pause,
      Capability.Play,
      Capability.SeekTo
    ],
    notificationCapabilities: [
      Capability.JumpBackward,
      Capability.JumpForward,
      Capability.Pause,
      Capability.Play,
      Capability.SeekTo
    ],
    // alwaysPauseOnInterruption caused serious problems with the player unpausing
    // every time the user receives a notification.
    alwaysPauseOnInterruption: Platform.OS === 'ios',
    stopWithApp: true,
    backwardJumpInterval: parseInt(jumpBackwardsTime, 10),
    forwardJumpInterval: parseInt(jumpForwardsTime, 10)
  })
}

/*
  state key for android
  NOTE: ready and pause use the same number, so there is no true ready state for Android :[
  none      0
  stopped   1
  paused    2
  playing   3
  ready     2
  buffering 6
  ???       8
*/
export const checkIfStateIsBuffering = (playbackState: any) =>
  // for iOS
  playbackState === State.Buffering ||
  // for Android
  playbackState === 6 ||
  playbackState === 8

export const getClipHasEnded = async () => {
  const clipHasEnded = await AsyncStorage.getItem(PV.Keys.CLIP_HAS_ENDED)
  return clipHasEnded === 'true'
}

export const handleResumeAfterClipHasEnded = async () => {
  await AsyncStorage.removeItem(PV.Keys.PLAYER_CLIP_IS_LOADED)
  const nowPlayingItem = await getNowPlayingItemLocally()
  const nowPlayingItemEpisode = convertNowPlayingItemClipToNowPlayingItemEpisode(nowPlayingItem)
  const playbackPosition = await PVTrackPlayer.getTrackPosition()
  const mediaFileDuration = await PVTrackPlayer.getTrackDuration()
  await addOrUpdateHistoryItem(nowPlayingItemEpisode, playbackPosition, mediaFileDuration)
  PVEventEmitter.emit(PV.Events.PLAYER_RESUME_AFTER_CLIP_HAS_ENDED)
}

export const playerJumpBackward = async (seconds: string) => {
  const position = await PVTrackPlayer.getTrackPosition()
  const newPosition = position - parseInt(seconds, 10)
  await PVTrackPlayer.seekTo(newPosition)
  return newPosition
}

export const playerJumpForward = async (seconds: string) => {
  const position = await PVTrackPlayer.getTrackPosition()
  const newPosition = position + parseInt(seconds, 10)
  await PVTrackPlayer.seekTo(newPosition)
  return newPosition
}

let playerPreviewEndTimeInterval: any = null

export const playerPreviewEndTime = async (endTime: number) => {
  if (playerPreviewEndTimeInterval) {
    clearInterval(playerPreviewEndTimeInterval)
  }

  const previewEndTime = endTime - 3
  await PVTrackPlayer.seekTo(previewEndTime)
  handlePlay()

  playerPreviewEndTimeInterval = setInterval(() => {
    (async () => {
      const currentPosition = await PVTrackPlayer.getTrackPosition()
      if (currentPosition >= endTime) {
        clearInterval(playerPreviewEndTimeInterval)
        PVTrackPlayer.pause()
      }
    })()
  }, 500)
}

export const setRateWithLatestPlaybackSpeed = async () => {
  const rate = await getPlaybackSpeed()

  // https://github.com/DoubleSymmetry/react-native-track-player/issues/766
  if (Platform.OS === 'ios') {
    PVTrackPlayer.setRate(rate)
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    setTimeout( () => PVTrackPlayer.setRate(rate), 200)
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    setTimeout( () => PVTrackPlayer.setRate(rate), 500)
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    setTimeout( () => PVTrackPlayer.setRate(rate), 800)
  } else {
    PVTrackPlayer.setRate(rate)
  }
}

export const playerPreviewStartTime = async (startTime: number, endTime?: number | null) => {
  if (playerPreviewEndTimeInterval) {
    clearInterval(playerPreviewEndTimeInterval)
  }

  await PVTrackPlayer.seekTo(startTime)
  handlePlay()

  if (endTime) {
    playerPreviewEndTimeInterval = setInterval(() => {
      (async () => {
        const currentPosition = await PVTrackPlayer.getTrackPosition()
        if (currentPosition >= endTime) {
          clearInterval(playerPreviewEndTimeInterval)
          PVTrackPlayer.pause()
        }
      })()
    }, 500)
  }
}

export const setClipHasEnded = async (clipHasEnded: boolean) => {
  await AsyncStorage.setItem(PV.Keys.CLIP_HAS_ENDED, JSON.stringify(clipHasEnded))
}

const getDownloadedFilePath = async (id: string, episodeMediaUrl: string) => {
  const ext = getExtensionFromUrl(episodeMediaUrl)
  const downloader = await BackgroundDownloader()

  /* If downloaded episode is for an addByRSSPodcast, then the episodeMediaUrl
     will be the id, so remove the URL params from the URL, and don't append
     an extension to the file path.
  */
  if (id && id.indexOf('http') > -1) {
    const idWithoutUrlParams = id.split('?')[0]
    return `${downloader.directories.documents}/${idWithoutUrlParams}`
  } else {
    return `${downloader.directories.documents}/${id}${ext}`
  }
}

const checkIfFileIsDownloaded = async (id: string, episodeMediaUrl: string) => {
  let isDownloadedFile = true
  const filePath = await getDownloadedFilePath(id, episodeMediaUrl)

  try {
    await RNFS.stat(filePath)
  } catch (innerErr) {
    isDownloadedFile = false
  }
  return isDownloadedFile
}

export const getCurrentLoadedTrackId = async () => {
  const trackIndex = await PVTrackPlayer.getCurrentTrack()
  const trackId = await getLoadedTrackIdByIndex(trackIndex)
  return trackId
}

export const getLoadedTrackIdByIndex = async (trackIndex: number) => {
  let trackId = ''
  if (trackIndex > 0 || trackIndex === 0) {
    const track = await PVTrackPlayer.getTrack(trackIndex)
    if (track?.id) {
      trackId = track.id
    }
  }

  return trackId
}

/*
  Always use await with updateUserPlaybackPosition to make sure that
  getTrackPosition and getTrackDuration are accurate for the currently playing item.
  addOrUpdateHistoryItem can be called without await.
*/
export const updateUserPlaybackPosition = async (skipSetNowPlaying?: boolean, shouldAwait?: boolean) => {
  try {
    const currentTrackId = await getCurrentLoadedTrackId()
    const setPlayerClipIsLoadedIfClip = false

    const currentNowPlayingItem = await getNowPlayingItemFromQueueOrHistoryOrDownloadedByTrackId(
      currentTrackId,
      setPlayerClipIsLoadedIfClip
    )

    if (currentNowPlayingItem) {
      const lastPosition = await PVTrackPlayer.getTrackPosition()
      const duration = await PVTrackPlayer.getTrackDuration()
      const forceUpdateOrderDate = false

      if (duration > 0 && lastPosition >= duration - 10) {
        if (shouldAwait) {
          await addOrUpdateHistoryItem(currentNowPlayingItem, 0, duration, forceUpdateOrderDate, skipSetNowPlaying)
        } else {
          addOrUpdateHistoryItem(currentNowPlayingItem, 0, duration, forceUpdateOrderDate, skipSetNowPlaying)
        }
      } else if (lastPosition > 0) {
        if (shouldAwait) {
          await addOrUpdateHistoryItem(
            currentNowPlayingItem,
            lastPosition,
            duration,
            forceUpdateOrderDate,
            skipSetNowPlaying
          )
        } else {
          addOrUpdateHistoryItem(
            currentNowPlayingItem,
            lastPosition,
            duration,
            forceUpdateOrderDate,
            skipSetNowPlaying
          )
        }
      }
    }
  } catch (error) {
    console.log('updateUserPlaybackPosition error', error)
  }
}

export const initializePlayerQueue = async () => {
  try {
    const queueItems = await getQueueItems()
    let filteredItems = [] as any

    const item = await getNowPlayingItemLocally()
    if (item) {
      filteredItems = filterItemFromQueueItems(queueItems, item)
      filteredItems.unshift(item)
    }

    if (filteredItems.length > 0) {
      const tracks = await createTracks(filteredItems)
      PVTrackPlayer.add(tracks)
    }

    return item
  } catch (error) {
    console.log('Initializing player error: ', error)
  }
}

export const loadItemAndPlayTrack = async (
  item: NowPlayingItem,
  shouldPlay: boolean,
  forceUpdateOrderDate: boolean,
  itemToSetNextInQueue: NowPlayingItem | null
) => {
  if (!item) return
  const { addCurrentItemNextInQueue } = getGlobal()

  if (
    addCurrentItemNextInQueue
    && itemToSetNextInQueue
    && item.episodeId !== itemToSetNextInQueue.episodeId
  ) {  
    addQueueItemNext(itemToSetNextInQueue)
  }

  const newItem = item

  const skipSetNowPlaying = true
  await updateUserPlaybackPosition(skipSetNowPlaying)

  // check if loading a chapter, and if the now playing item is the same episode.
  // if it is, then call setPlaybackposition, and play if shouldPlay, then return.
  // else, if a chapter, play like a normal episode, starting at the time stamp

  PVTrackPlayer.pause()

  const lastPlayingItem = await getNowPlayingItemLocally()
  const historyItemsIndex = await getHistoryItemsIndexLocally()

  const { clipId, episodeId } = item
  if (!clipId && episodeId) {
    item.episodeDuration = historyItemsIndex?.episodes[episodeId]?.mediaFileDuration || 0
  }

  addOrUpdateHistoryItem(item, item.userPlaybackPosition || 0, item.episodeDuration || 0, forceUpdateOrderDate)

  if (Platform.OS === 'ios') {
    await AsyncStorage.setItem(PV.Keys.PLAYER_PREVENT_HANDLE_QUEUE_ENDED, 'true')
    PVTrackPlayer.reset()
    const track = (await createTrack(item)) as Track
    await PVTrackPlayer.add(track)
    await AsyncStorage.removeItem(PV.Keys.PLAYER_PREVENT_HANDLE_QUEUE_ENDED)
    await syncPlayerWithQueue()
  } else {
    const currentId = await getCurrentLoadedTrackId()
    if (currentId) {
      PVTrackPlayer.removeUpcomingTracks()
      const track = (await createTrack(item)) as Track
      await PVTrackPlayer.add(track)
      await PVTrackPlayer.skipToNext()
      await syncPlayerWithQueue()
    } else {
      const track = (await createTrack(item)) as Track
      await PVTrackPlayer.add(track)
      await syncPlayerWithQueue()
    }
  }

  if (shouldPlay) {
    if (item && !item.clipId) {
      setTimeout(() => {
        handlePlay()
      }, 1500)
    } else if (item && item.clipId) {
      AsyncStorage.setItem(PV.Keys.PLAYER_SHOULD_PLAY_WHEN_CLIP_IS_LOADED, 'true')
    }
  }

  if (lastPlayingItem && lastPlayingItem.episodeId && lastPlayingItem.episodeId !== item.episodeId) {
    PVEventEmitter.emit(PV.Events.PLAYER_NEW_EPISODE_LOADED)
  }

  return newItem
}

export const playNextFromQueue = async () => {
  const queueItems = await PVTrackPlayer.getQueue()
  if (queueItems && queueItems.length > 1) {
    await PVTrackPlayer.skipToNext()
    const currentId = await getCurrentLoadedTrackId()
    const setPlayerClipIsLoadedIfClip = true
    const item = await getNowPlayingItemFromQueueOrHistoryOrDownloadedByTrackId(
      currentId, setPlayerClipIsLoadedIfClip)
    if (item) {
      await addOrUpdateHistoryItem(item, item.userPlaybackPosition || 0, item.episodeDuration || 0)
      return item
    }
  }
}

export const addItemToPlayerQueueNext = async (item: NowPlayingItem) => {
  await addQueueItemNext(item)
  await syncPlayerWithQueue()
}

export const addItemToPlayerQueueLast = async (item: NowPlayingItem) => {
  await addQueueItemLast(item)
  await syncPlayerWithQueue()
}

export const syncPlayerWithQueue = async () => {
  try {
    const pvQueueItems = await getQueueItemsLocally()
    PVTrackPlayer.removeUpcomingTracks()
    const tracks = await createTracks(pvQueueItems)
    await PVTrackPlayer.add(tracks)
  } catch (error) {
    console.log('syncPlayerWithQueue error:', error)
  }
}

export const updateCurrentTrack = async (trackTitle?: string, artworkUrl?: string) => {
  try {
    const currentIndex = await PVTrackPlayer.getCurrentTrack()
    if (currentIndex > 0 || currentIndex === 0) {
      const track = await PVTrackPlayer.getTrack(currentIndex)
      
      if (track) {
        const newTrack = {
          ...track,
          ...(trackTitle ? { title: trackTitle } : {}),
          ...(artworkUrl ? { artwork: artworkUrl } : {})
        } as Track
      
        await PVTrackPlayer.updateMetadataForTrack(currentIndex, newTrack)
      }
    }
  } catch (error) {
    console.log('updateCurrentTrack error:', error)
  }
}

export const createTrack = async (item: NowPlayingItem) => {
  if (!item) return

  const {
    addByRSSPodcastFeedUrl,
    clipId,
    episodeId,
    episodeMediaUrl = '',
    episodeTitle = 'Untitled Episode',
    podcastCredentialsRequired,
    podcastId,
    podcastImageUrl,
    podcastShrunkImageUrl,
    podcastTitle = 'Untitled Podcast'
  } = item
  let track = null
  const imageUrl = podcastShrunkImageUrl ? podcastShrunkImageUrl : podcastImageUrl

  const id = clipId || episodeId
  let finalFeedUrl = addByRSSPodcastFeedUrl

  /*
    If credentials are required but it is a podcast stored in our database,
    then get the authority feedUrl for the podcast before proceeding.
  */
  if (podcastCredentialsRequired && !addByRSSPodcastFeedUrl && podcastId) {
    finalFeedUrl = await getPodcastFeedUrlAuthority(podcastId)
  }

  if (episodeId) {
    const isDownloadedFile = await checkIfFileIsDownloaded(episodeId, episodeMediaUrl)
    const filePath = await getDownloadedFilePath(episodeId, episodeMediaUrl)

    if (isDownloadedFile) {
      track = {
        id,
        url: `file://${filePath}`,
        title: episodeTitle,
        artist: podcastTitle,
        ...(imageUrl ? { artwork: imageUrl } : {}),
        userAgent: getAppUserAgent(),
        pitchAlgorithm: PitchAlgorithm.Voice
      }
    } else {
      const Authorization = await getPodcastCredentialsHeader(finalFeedUrl)

      track = {
        id,
        url: episodeMediaUrl,
        title: episodeTitle,
        artist: podcastTitle,
        ...(imageUrl ? { artwork: imageUrl } : {}),
        userAgent: getAppUserAgent(),
        pitchAlgorithm: PitchAlgorithm.Voice,
        headers: {
          ...(Authorization ? { Authorization } : {})
        }
      }
    }
  }

  return track
}

export const createTracks = async (items: NowPlayingItem[]) => {
  const tracks = [] as Track[]
  for (const item of items) {
    const track = (await createTrack(item)) as Track
    tracks.push(track)
  }

  return tracks
}

export const movePlayerItemToNewPosition = async (id: string, newIndex: number) => {
  const playerQueueItems = await PVTrackPlayer.getQueue()

  const previousIndex = playerQueueItems.findIndex((x: any) => x.id === id)

  if (previousIndex > 0 || previousIndex === 0) {
    try {
      await PVTrackPlayer.remove(previousIndex)
      const pvQueueItems = await getQueueItemsLocally()
      const itemToMove = pvQueueItems.find(
        (x: any) => (x.clipId && x.clipId === id) || (!x.clipId && x.episodeId === id)
      )
      if (itemToMove) {
        const track = await createTrack(itemToMove) as any
        await PVTrackPlayer.add([track], newIndex)
      }
    } catch (error) {
      console.log('movePlayerItemToNewPosition error:', error)
    }
  }
}

export const setPlaybackPosition = async (position?: number) => {
  const currentId = await getCurrentLoadedTrackId()
  if (currentId && (position || position === 0 || (position && position > 0))) {
    await PVTrackPlayer.seekTo(position)
  }
}

// Sometimes the duration is not immediately available for certain episodes.
// For those cases, use a setInterval before adjusting playback position.
export const setPlaybackPositionWhenDurationIsAvailable = async (
  position: number,
  trackId?: string,
  resolveImmediately?: boolean,
  shouldPlay?: boolean
) => {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      (async () => {
        const duration = await PVTrackPlayer.getTrackDuration()
        const currentTrackId = await getCurrentLoadedTrackId()

        setTimeout(() => {
          if (interval) clearInterval(interval)
        }, 20000)

        if (duration && duration > 0 && (!trackId || trackId === currentTrackId) && position >= 0) {
          clearInterval(interval)
          await PVTrackPlayer.seekTo(position)
          // Sometimes seekTo does not work right away for all episodes...
          // to work around this bug, we set another interval to confirm the track
          // position has been advanced into the clip time.
          const confirmClipLoadedInterval = setInterval(() => {
            (async () => {
              const currentPosition = await PVTrackPlayer.getTrackPosition()
              if (currentPosition >= position - 1) {
                clearInterval(confirmClipLoadedInterval)
              } else {
                await PVTrackPlayer.seekTo(position)
              }
            })()
          }, 500)

          const shouldPlayWhenClipIsLoaded = await AsyncStorage.getItem(PV.Keys.PLAYER_SHOULD_PLAY_WHEN_CLIP_IS_LOADED)

          if (shouldPlay) {
            handlePlay()
          } else if (shouldPlayWhenClipIsLoaded === 'true') {
            AsyncStorage.removeItem(PV.Keys.PLAYER_SHOULD_PLAY_WHEN_CLIP_IS_LOADED)
            handlePlay()
          }

          resolve(null)
        }
        if (resolveImmediately) resolve(null)
      })()
    }, 500)
  })
}

export const restartNowPlayingItemClip = async () => {
  const nowPlayingItem = await getNowPlayingItem()
  if (nowPlayingItem && nowPlayingItem.clipStartTime) {
    setPlaybackPosition(nowPlayingItem.clipStartTime)
    handlePlay()
  }
}

export const setPlaybackSpeed = async (rate: number) => {
  await AsyncStorage.setItem(PV.Keys.PLAYER_PLAYBACK_SPEED, JSON.stringify(rate))

  const currentState = await PVTrackPlayer.getState()
  const isPlaying = currentState === State.Playing

  if (isPlaying) {
    await PVTrackPlayer.setRate(rate)
  }
}

export const getPlaybackSpeed = async () => {
  try {
    const rate = await AsyncStorage.getItem(PV.Keys.PLAYER_PLAYBACK_SPEED)
    if (rate) {
      return parseFloat(rate)
    } else {
      return 1.0
    }
  } catch (error) {
    return 1.0
  }
}

/*
  WARNING! THIS UGLY FUNCTION DOES A LOT MORE THAN JUST "GETTING" THE ITEM.
  IT ALSO REMOVES AN ITEM FROM THE QUEUE, AND HANDLES CONVERTING
  A CLIP TO AN EPISODE OBJECT. THIS FUNCTION REALLY SHOULD BE REWRITTEN.
*/
export const getNowPlayingItemFromQueueOrHistoryOrDownloadedByTrackId = async (
  trackId: string,
  setPlayerClipIsLoadedIfClip?: boolean
) => {
  if (!trackId) return null

  const results = await getHistoryItemsLocally()
  const { userHistoryItems } = results
  let currentNowPlayingItem = userHistoryItems.find((x: any) =>
    checkIfIdMatchesClipIdOrEpisodeIdOrAddByUrl(trackId, x.clipId, x.episodeId)
  )

  if (!currentNowPlayingItem) {
    const queueItems = await getQueueItemsLocally()
    const queueItemIndex = queueItems.findIndex((x: any) =>
      checkIfIdMatchesClipIdOrEpisodeIdOrAddByUrl(trackId, x.clipId, x.episodeId)
    )
    currentNowPlayingItem = queueItemIndex > -1 && queueItems[queueItemIndex]
  }

  if (!currentNowPlayingItem) {
    currentNowPlayingItem = await getDownloadedEpisode(trackId)
    if (currentNowPlayingItem) {
      currentNowPlayingItem = convertToNowPlayingItem(
        currentNowPlayingItem, null, null, currentNowPlayingItem.userPlaybackPosition
      )
    }
  }

  if (setPlayerClipIsLoadedIfClip && currentNowPlayingItem?.clipId) {
    await AsyncStorage.setItem(PV.Keys.PLAYER_CLIP_IS_LOADED, 'TRUE')
  }

  const playerClipIsLoaded = await AsyncStorage.getItem(PV.Keys.PLAYER_CLIP_IS_LOADED)
  if (!playerClipIsLoaded && currentNowPlayingItem?.clipId) {
    currentNowPlayingItem = convertNowPlayingItemClipToNowPlayingItemEpisode(currentNowPlayingItem)
  }

  return currentNowPlayingItem
}

export const togglePlay = async () => {
  const state = await PVTrackPlayer.getState()

  if (state === State.None) {
    handlePlay()
    return
  }

  if (state === State.Playing) {
    handlePause()
  } else {
    handlePlay()
  }
}

export const handlePlay = () => {
  PVTrackPlayer.play()
  setRateWithLatestPlaybackSpeed()
  updateUserPlaybackPosition()
}

export const handlePause = () => {
  PVTrackPlayer.pause()
  updateUserPlaybackPosition()
}

export const handleSeek = async (position: number) => {
  await PVTrackPlayer.seekTo(Math.floor(position))
  updateUserPlaybackPosition()
}

export const handleStop = () => {
  PVTrackPlayer.stop()
}

export const checkIdlePlayerState = async () => {
  const state = await PVTrackPlayer.getState()
  return state === 0 || state === State.None
}

export const setPlayerJumpBackwards = (val?: string) => {
  const newValue = val && parseInt(val, 10) > 0 || val === '' ? val : PV.Player.jumpBackSeconds.toString()
  if (newValue !== '') {
    AsyncStorage.setItem(PV.Keys.PLAYER_JUMP_BACKWARDS, newValue.toString())
  }
  return newValue
}

export const setPlayerJumpForwards = (val?: string) => {
  const newValue = val && parseInt(val, 10) > 0 || val === '' ? val : PV.Player.jumpSeconds.toString()
  if (newValue !== '') {
    AsyncStorage.setItem(PV.Keys.PLAYER_JUMP_FORWARDS, newValue.toString())
  }
  return newValue
}
