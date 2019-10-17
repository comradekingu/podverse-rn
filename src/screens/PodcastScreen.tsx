import debounce from 'lodash/debounce'
import { Text, View as RNView } from 'react-native'
import { NavigationScreenOptions } from 'react-navigation'
import React from 'reactn'
import { ActionSheet, ActivityIndicator, ClipTableCell, Divider, EpisodeTableCell, FlatList, HTMLScrollView,
  NavQueueIcon, NavShareIcon, PodcastTableHeader, SearchBar, SwipeRowBack, SwitchWithText, TableSectionHeader,
  TableSectionSelectors, View, NumberSelectorWithText } from '../components'
import { getDownloadedEpisodeLimit } from '../lib/downloadedEpisodeLimiter'
import { getDownloadedEpisodes } from '../lib/downloadedPodcast'
import { downloadEpisode } from '../lib/downloader'
import { alertIfNoNetworkConnection } from '../lib/network'
import { convertNowPlayingItemToEpisode, convertToNowPlayingItem } from '../lib/NowPlayingItem'
import { decodeHTMLString, readableDate, removeHTMLFromString, safelyUnwrapNestedVariable } from '../lib/utility'
import { PV } from '../resources'
import { getEpisodes } from '../services/episode'
import { getMediaRefs } from '../services/mediaRef'
import { getPodcast } from '../services/podcast'
import { removeDownloadedPodcastEpisode, updateAutoDownloadSettings } from '../state/actions/downloads'
import { toggleSubscribeToPodcast } from '../state/actions/podcast'
import { core, darkTheme } from '../styles'

const { aboutKey, allEpisodesKey, clipsKey, downloadedKey, mostRecentKey, mostRecentAllKey, oldestKey, topPastDay,
  topPastMonth, topPastWeek, topPastYear } = PV.Filters

type Props = {
  navigation?: any
}

type State = {
  downloadedEpisodeLimit: number | null
  endOfResultsReached: boolean
  flatListData: any[]
  flatListDataTotalCount: number | null
  isLoading: boolean
  isLoadingMore: boolean
  isRefreshing: boolean
  isSearchScreen?: boolean
  isSubscribing: boolean
  limitDownloadedEpisodes: boolean
  podcast?: any
  podcastId?: string
  queryPage: number
  querySort: string | null
  searchBarText: string
  selectedItem?: any
  showActionSheet: boolean
  showSettings: boolean
  viewType: string | null
}

export class PodcastScreen extends React.Component<Props, State> {

  static navigationOptions = ({ navigation }) => {
    const podcastId = navigation.getParam('podcastId')
    const podcastTitle = navigation.getParam('podcastTitle')
    return {
      title: 'Podcast',
      headerRight: (
        <RNView style={core.row}>
          <NavShareIcon
            endingText=' – shared using Podverse'
            podcastTitle={podcastTitle}
            url={PV.URLs.podcast + podcastId} />
          <NavQueueIcon navigation={navigation} />
        </RNView>
      )
    } as NavigationScreenOptions
  }

  constructor(props: Props) {
    super(props)

    const podcast = this.props.navigation.getParam('podcast')
    const podcastId = (podcast && podcast.id) || this.props.navigation.getParam('podcastId')
    const viewType = this.props.navigation.getParam('viewType') || allEpisodesKey

    if (podcast && podcast.id) {
      this.props.navigation.setParams({
        podcastId: podcast.id,
        podcastTitle: podcast.title
      })
    }

    this.state = {
      downloadedEpisodeLimit: null,
      endOfResultsReached: false,
      flatListData: [],
      flatListDataTotalCount: null,
      isLoading: viewType !== downloadedKey || !podcast,
      isLoadingMore: false,
      isRefreshing: false,
      isSubscribing: false,
      limitDownloadedEpisodes: false,
      podcast,
      podcastId,
      queryPage: 1,
      querySort: mostRecentKey,
      searchBarText: '',
      showActionSheet: false,
      showSettings: false,
      viewType
    }

    this._handleSearchBarTextQuery = debounce(this._handleSearchBarTextQuery, PV.SearchBar.textInputDebounceTime)
  }

  async componentDidMount() {
    const { navigation } = this.props
    const episodeId = navigation.getParam('navToEpisodeWithId')
    this._initializePageData()

    if (episodeId) {
      navigation.navigate(PV.RouteNames.EpisodeScreen, { episodeId })
    }
  }

  async _initializePageData() {
    const { podcast, viewType } = this.state
    const podcastId = this.props.navigation.getParam('podcastId') || this.state.podcastId
    const downloadedEpisodeLimit = await getDownloadedEpisodeLimit(podcastId)

    this.setState({
      downloadedEpisodeLimit,
      endOfResultsReached: false,
      flatListData: [],
      flatListDataTotalCount: null,
      isLoading: true,
      limitDownloadedEpisodes: downloadedEpisodeLimit && downloadedEpisodeLimit > 0,
      podcastId,
      queryPage: 1
    }, async () => {
      let newState = {}
      let newPodcast: any

      try {
        newPodcast = await getPodcast(podcastId)
        if (viewType === allEpisodesKey) {
          newState = await this._queryData(allEpisodesKey)
        } else if (viewType === clipsKey) {
          newState = await this._queryData(clipsKey)
        }

        newPodcast.description = newPodcast.description || 'No summary available.'

        this.setState({
          ...newState,
          isLoading: false,
          podcast: newPodcast
        })
      } catch (error) {
        this.setState({
          ...newState,
          isLoading: false,
          ...(newPodcast ? { podcast: newPodcast } : { podcast })
        })
      }
    })
  }

  selectLeftItem = async (selectedKey: string) => {
    if (!selectedKey) {
      this.setState({ viewType: null })
      return
    }

    this.setState({
      endOfResultsReached: false,
      flatListData: [],
      flatListDataTotalCount: null,
      isLoading: true,
      queryPage: 1,
      viewType: selectedKey
    }, async () => {
      const newState = await this._queryData(selectedKey)
      this.setState(newState)
    })
  }

  selectRightItem = async (selectedKey: string) => {
    if (!selectedKey) {
      this.setState({ querySort: null })
      return
    }

    this.setState({
      endOfResultsReached: false,
      flatListData: [],
      flatListDataTotalCount: null,
      isLoading: true,
      queryPage: 1,
      querySort: selectedKey
    }, async () => {
      const newState = await this._queryData(selectedKey)
      this.setState(newState)
    })
  }

  _onEndReached = ({ distanceFromEnd }) => {
    const { endOfResultsReached, isLoadingMore, queryPage = 1, viewType } = this.state
    if (viewType !== downloadedKey && !endOfResultsReached && !isLoadingMore) {
      if (distanceFromEnd > -1) {
        this.setState({
          isLoadingMore: true
        }, async () => {
          const newState = await this._queryData(viewType, {
            queryPage: queryPage + 1,
            searchAllFieldsText: this.state.searchBarText
          })
          this.setState(newState)
        })
      }
    }
  }

  _onRefresh = () => {
    const { viewType } = this.state

    this.setState({
      isRefreshing: true
    }, async () => {
      const newState = await this._queryData(viewType, { queryPage: 1 })
      this.setState(newState)
    })
  }

  _ListHeaderComponent = () => {
    const { searchBarText } = this.state

    return (
      <View style={styles.ListHeaderComponent}>
        <SearchBar
          inputContainerStyle={core.searchBar}
          onChangeText={this._handleSearchBarTextChange}
          onClear={this._handleSearchBarClear}
          value={searchBarText} />
      </View>
    )
  }

  _ItemSeparatorComponent = () => {
    return <Divider />
  }

  _handleCancelPress = () => {
    return new Promise((resolve, reject) => {
      this.setState({ showActionSheet: false }, resolve)
    })
  }

  _handleMorePress = (selectedItem: any) => {
    this.setState({
      selectedItem,
      showActionSheet: true
    })
  }

  _renderItem = ({ item }) => {
    const { podcast, viewType } = this.state

    const episode = {
      ...item,
      podcast
    }
    const isSearchScreen = this.props.navigation.getParam('isSearchScreen')
    const screen = isSearchScreen ? PV.RouteNames.SearchEpisodeScreen : PV.RouteNames.EpisodeScreen

    if (viewType === downloadedKey) {
      let description = removeHTMLFromString(item.description)
      description = decodeHTMLString(description)
      return (
        <EpisodeTableCell
          description={description}
          handleMorePress={() => this._handleMorePress(convertToNowPlayingItem(item, null, podcast))}
          handleNavigationPress={() => this.props.navigation.navigate(screen, { episode })}
          id={item.id}
          pubDate={item.pubDate}
          title={item.title} />
      )
    } else if (viewType === allEpisodesKey) {
      let description = removeHTMLFromString(item.description)
      description = decodeHTMLString(description)
      return (
        <EpisodeTableCell
          description={description}
          handleMorePress={() => this._handleMorePress(convertToNowPlayingItem(item, null, podcast))}
          handleNavigationPress={() => this.props.navigation.navigate(screen, { episode })}
          id={item.id}
          pubDate={item.pubDate}
          title={item.title} />
      )
    } else {
      return (
        <ClipTableCell
          endTime={item.endTime}
          episodeId={item.episode.id}
          episodePubDate={readableDate(item.episode.pubDate)}
          episodeTitle={item.episode.title}
          handleMorePress={() => this._handleMorePress(convertToNowPlayingItem(item, null, podcast))}
          startTime={item.startTime}
          title={item.title} />
      )
    }
  }

  _renderHiddenItem = ({ item }, rowMap) => (
    <SwipeRowBack
      onPress={() => this._handleHiddenItemPress(item.id, rowMap)}
      text='Delete' />
  )

  _handleHiddenItemPress = async (selectedId, rowMap) => {
    const filteredEpisodes = this.state.flatListData.filter((x: any) => x.id !== selectedId)
    this.setState({
      flatListData: filteredEpisodes
    }, async () => {
      await removeDownloadedPodcastEpisode(selectedId)
      const finalDownloadedEpisodes = await getDownloadedEpisodes()
      this.setState({ flatListData: finalDownloadedEpisodes })
    })
  }

  _handleSearchBarTextChange = (text: string) => {
    const { viewType } = this.state

    this.setState({
      isLoadingMore: true,
      searchBarText: text
    }, async () => {
      this._handleSearchBarTextQuery(viewType, { searchAllFieldsText: text })
    })
  }

  _handleSearchBarTextQuery = async (viewType: string | null, queryOptions: any) => {
    this.setState({
      flatListData: [],
      flatListDataTotalCount: null,
      queryPage: 1
    }, async () => {
      const state = await this._queryData(viewType, { searchAllFieldsText: queryOptions.searchAllFieldsText })
      this.setState(state)
    })
  }

  _handleSearchBarClear = (text: string) => {
    this.setState({ searchBarText: '' })
  }

  _toggleSubscribeToPodcast = async () => {
    const { podcastId } = this.state
    const wasAlerted = await alertIfNoNetworkConnection('subscribe to podcast')
    if (wasAlerted) return

    this.setState({ isSubscribing: true }, async () => {
      try {
        await toggleSubscribeToPodcast(podcastId, this.global)
        this.setState({ isSubscribing: false })
      } catch (error) {
        this.setState({ isSubscribing: false })
      }
    })
  }

  _handleDownloadPressed = () => {
    if (this.state.selectedItem) {
      const episode = convertNowPlayingItemToEpisode(this.state.selectedItem)
      downloadEpisode(episode, episode.podcast)
    }
  }

  _handleToggleAutoDownload = (autoDownloadOn: boolean) => {
    const { podcast, podcastId } = this.state
    const id = (podcast && podcast.id) || podcastId
    if (id) updateAutoDownloadSettings(id, autoDownloadOn)
  }

  _handleToggleSettings = () => {
    this.setState({ showSettings: !this.state.showSettings })
  }

  _handleToggleLimitDownloads = () => {
    this.setState({ limitDownloadedEpisodes: !this.state.limitDownloadedEpisodes })
  }

  _handleSelectDownloadLimit = (value: number) => {
    this.setState({ downloadedEpisodeLimit: value })
  }

  render() {
    const { navigation } = this.props
    const { globalTheme } = this.global
    const isDarkMode = globalTheme === darkTheme
    const { downloadedEpisodeLimit, isLoading, isLoadingMore, isRefreshing, isSubscribing, limitDownloadedEpisodes,
      podcast, podcastId, querySort, selectedItem, showActionSheet, showSettings, viewType } = this.state
    const subscribedPodcastIds = safelyUnwrapNestedVariable(() => this.global.session.userInfo.subscribedPodcastIds, [])
    const isSubscribed = subscribedPodcastIds.some((x: string) => x === podcastId)
    let { flatListData, flatListDataTotalCount } = this.state
    const { autoDownloadSettings } = this.global
    const autoDownloadOn = (podcast && autoDownloadSettings[podcast.id])
      || (podcastId && autoDownloadSettings[podcastId])

    let items = rightItems(false, viewType === allEpisodesKey)
    if (viewType === downloadedKey) {
      const { downloadedPodcasts } = this.global
      const downloadedPodcast = downloadedPodcasts.find((x: any) => ((podcast && x.id === podcast.id) || x.id === podcastId))
      flatListData = (downloadedPodcast && downloadedPodcast.episodes) || []
      flatListDataTotalCount = flatListData.length
      items = rightItems(true)
    } else if (!viewType || viewType === aboutKey) {
      items = []
    }

    const resultsText = (viewType === downloadedKey && 'episodes') ||
      (viewType === allEpisodesKey && 'episodes') ||
      (viewType === clipsKey && 'clips') || 'results'

    return (
      <View style={styles.view}>
        <PodcastTableHeader
          autoDownloadOn={autoDownloadOn}
          handleToggleAutoDownload={this._handleToggleAutoDownload}
          handleToggleSettings={this._handleToggleSettings}
          handleToggleSubscribe={this._toggleSubscribeToPodcast}
          isLoading={isLoading && !podcast}
          isNotFound={!isLoading && !podcast}
          isSubscribed={isSubscribed}
          isSubscribing={isSubscribing}
          podcastImageUrl={podcast && podcast.imageUrl}
          podcastTitle={podcast && podcast.title} />
        {
          !showSettings &&
            <TableSectionSelectors
              handleSelectLeftItem={this.selectLeftItem}
              handleSelectRightItem={this.selectRightItem}
              leftItems={leftItems}
              rightItems={items}
              selectedLeftItemKey={viewType}
              selectedRightItemKey={querySort} />
        }
        {
          showSettings && <TableSectionHeader title='Settings' />
        }
        {
          showSettings &&
            <View style={styles.settingsView}>
              <SwitchWithText
                onValueChange={this._handleToggleLimitDownloads}
                text={limitDownloadedEpisodes ? 'Download limit on' : 'Download limit off'}
                value={limitDownloadedEpisodes} />
              <NumberSelectorWithText
                handleSelectNumber={this._handleSelectDownloadLimit}
                items={downloadLimitItems}
                selectedNumber={downloadedEpisodeLimit}
                text='Download limit maximum' />
            </View>
        }
        {
          !showSettings &&
            <View style={styles.view}>
              {
                isLoading && <ActivityIndicator />
              }
              {
                !isLoading && viewType !== aboutKey && flatListData && podcast &&
                  <FlatList
                    data={flatListData}
                    dataTotalCount={flatListDataTotalCount}
                    disableLeftSwipe={viewType !== downloadedKey}
                    extraData={flatListData}
                    {...(viewType === downloadedKey ? { handleHiddenItemPress: this._handleHiddenItemPress } : {})}
                    hideEndOfResults={querySort === mostRecentAllKey}
                    isLoadingMore={isLoadingMore}
                    isRefreshing={isRefreshing}
                    ItemSeparatorComponent={this._ItemSeparatorComponent}
                    {...(viewType === allEpisodesKey || viewType === clipsKey ? { ListHeaderComponent: this._ListHeaderComponent } : {})}
                    onEndReached={this._onEndReached}
                    renderHiddenItem={this._renderHiddenItem}
                    renderItem={this._renderItem}
                    resultsText={resultsText} />
              }
              {
                !isLoading && viewType === aboutKey && podcast &&
                  <HTMLScrollView
                    html={podcast.description}
                    navigation={navigation} />
              }
              <ActionSheet
                handleCancelPress={this._handleCancelPress}
                items={() => PV.ActionSheet.media.moreButtons(
                  selectedItem, navigation, this._handleCancelPress, this._handleDownloadPressed
                )}
                showModal={showActionSheet} />
            </View>
        }
      </View>
    )
  }

  _queryAllEpisodes = async (sort: string | null, page: number = 1) => {
    const { podcastId, searchBarText: searchAllFieldsText } = this.state
    const results = await getEpisodes({
      sort, page, podcastId, ...(searchAllFieldsText ? { searchAllFieldsText } : {})
    }, this.global.settings.nsfwMode)

    return results
  }

  _queryClips = async (sort: string | null, page: number = 1) => {
    const { podcastId, searchBarText: searchAllFieldsText } = this.state
    const results = await getMediaRefs({
      sort,
      page,
      podcastId,
      includeEpisode: true,
      ...(searchAllFieldsText ? { searchAllFieldsText } : {})
    }, this.global.settings.nsfwMode)
    return results
  }

  _queryData = async (filterKey: string | null, queryOptions: { queryPage?: number, searchAllFieldsText?: string } = {}) => {
    const { flatListData, podcastId, querySort, viewType } = this.state
    const newState = {
      isLoading: false,
      isLoadingMore: false,
      isRefreshing: false
    } as State

    const wasAlerted = await alertIfNoNetworkConnection('load data')
    if (wasAlerted) return newState

    try {
      if (filterKey === allEpisodesKey) {
        const results = await this._queryAllEpisodes(querySort, queryOptions.queryPage)
        newState.flatListData = [...flatListData, ...results[0]]
        newState.endOfResultsReached = newState.flatListData.length >= results[1]
        newState.flatListDataTotalCount = results[1]
      } else if (filterKey === clipsKey) {
        const results = await this._queryClips(querySort, queryOptions.queryPage)
        newState.flatListData = [...flatListData, ...results[0]]
        newState.endOfResultsReached = newState.flatListData.length >= results[1]
        newState.flatListDataTotalCount = results[1]
      } else if (rightItems(viewType === downloadedKey, viewType === allEpisodesKey).some((option) => option.value === filterKey)) {
        let results = []

        if (viewType === allEpisodesKey) {
          results = await this._queryAllEpisodes(querySort)
        } else if (viewType === clipsKey) {
          results = await this._queryClips(querySort)
        }

        newState.flatListData = [...flatListData, ...results[0]]
        newState.endOfResultsReached = newState.flatListData.length >= results[1]
        newState.flatListDataTotalCount = results[1]
      } else if (filterKey === aboutKey) {
        const newPodcast = await getPodcast(podcastId)
        newState.podcast = newPodcast
      }
      newState.queryPage = queryOptions.queryPage || 1
      return newState
    } catch (error) {
      console.log(error)
      return newState
    }

  }
}

const downloadLimitItems = [...Array(100)].map((_, i) => ({
  label: (i + 1).toString(),
  value: (i + 1).toString()
}))

const leftItems = [
  {
    label: 'Downloaded',
    value: downloadedKey
  },
  {
    label: 'All Episodes',
    value: allEpisodesKey
  },
  {
    label: 'Clips',
    value: clipsKey
  },
  {
    label: 'About',
    value: aboutKey
  }
]

const rightItems = (onlyMostRecent?: boolean, includeOldest?: boolean) => {
  const items = []

  if (onlyMostRecent) {
    items.push({
      label: 'most recent',
      value: mostRecentKey
    })
  } else {
    items.push(
      {
        label: 'most recent',
        value: mostRecentKey
      }
    )

    if (includeOldest) {
      items.push({
        label: 'oldest',
        value: oldestKey
      })
    }

    items.push(
      {
        label: 'top - past day',
        value: topPastDay
      },
      {
        label: 'top - past week',
        value: topPastWeek
      },
      {
        label: 'top - past month',
        value: topPastMonth
      },
      {
        label: 'top - past year',
        value: topPastYear
      },
      {
        label: 'most recent (all)',
        value: mostRecentAllKey
      }
    )
  }

  return items
}

const styles = {
  aboutView: {
    margin: 8
  },
  aboutViewText: {
    fontSize: PV.Fonts.sizes.lg
  },
  ListHeaderComponent: {
    borderBottomWidth: 0,
    borderTopWidth: 0,
    flex: 0,
    height: PV.FlatList.searchBar.height,
    justifyContent: 'center',
    marginVertical: 8
  },
  settingsView: {
    flex: 1,
    padding: 8
  },
  swipeRowBack: {
    marginBottom: 8,
    marginTop: 8
  },
  view: {
    flex: 1
  }
}
