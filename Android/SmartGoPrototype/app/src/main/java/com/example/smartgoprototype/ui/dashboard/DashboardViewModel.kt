package com.example.smartgoprototype.ui.dashboard

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.smartgoprototype.domain.model.Route
import com.example.smartgoprototype.data.preferences.UserPreferencesRepository
import com.example.smartgoprototype.domain.repository.AuthRepository
import com.example.smartgoprototype.domain.repository.RouteRepository
import com.example.smartgoprototype.notification.NotificationScheduler
import dagger.hilt.android.lifecycle.HiltViewModel
import java.time.DayOfWeek
import javax.inject.Inject
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch

@HiltViewModel
class DashboardViewModel @Inject constructor(
    private val routeRepository: RouteRepository,
    private val authRepository: AuthRepository,
    private val notificationScheduler: NotificationScheduler,
    private val userPreferencesRepository: UserPreferencesRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(DashboardUiState(isInitialLoading = true))
    val uiState: StateFlow<DashboardUiState> = _uiState

    // One-shot event: navigate to login after successful sign-out.
    private val _signOutEvent = Channel<Unit>(Channel.BUFFERED)
    val signOutEvent = _signOutEvent.receiveAsFlow()

    init {
        collectPreferences()
        collectRoutes()
        refreshRoutes()
    }

    fun refresh() = refreshRoutes()


    fun signOut() {
        viewModelScope.launch {
            authRepository.signOut().onSuccess {
                _signOutEvent.send(Unit)
            }.onFailure { e ->
                _uiState.value = _uiState.value.copy(errorMessage = e.message ?: "Sign out failed")
            }
        }
    }

    fun requestDelete(route: Route) {
        _uiState.value = _uiState.value.copy(pendingDeleteRoute = route)
    }

    fun dismissDeleteConfirmation() {
        _uiState.value = _uiState.value.copy(pendingDeleteRoute = null)
    }

    fun confirmDelete() {
        val route = _uiState.value.pendingDeleteRoute ?: return
        _uiState.value = _uiState.value.copy(pendingDeleteRoute = null, isDeletingRoute = true)

        viewModelScope.launch {
            try {
                // Room removes the route immediately (optimistic); the Flow re-emits automatically.
                // On failure the repo re-inserts the entity and throws, so we just show the error.
                routeRepository.deleteRoute(route.id)
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(errorMessage = e.message ?: "Failed to delete route")
            } finally {
                _uiState.value = _uiState.value.copy(isDeletingRoute = false)
            }
        }
    }

    fun toggleRouteActive(routeId: String) {
        val route = _uiState.value.routes.find { it.id == routeId } ?: return

        viewModelScope.launch {
            try {
                // The repo writes to Room first, which drives the UI update via the Flow.
                // On failure the repo reverts the local write and re-throws.
                routeRepository.updateRoute(routeId = routeId, userActive = !route.userActive)
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(errorMessage = e.message ?: "Failed to update route")
            }
        }
    }

    fun reorderRoutes(reordered: List<Route>) {
        viewModelScope.launch {
            try {
                routeRepository.reorderRoutes(reordered.map { it.id })
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(errorMessage = e.message ?: "Failed to reorder routes")
            }
        }
    }

    fun toggleNotifications() {
        val enabling = !_uiState.value.notificationsEnabled
        _uiState.value = _uiState.value.copy(notificationsEnabled = enabling)
        viewModelScope.launch {
            userPreferencesRepository.setNotificationsEnabled(enabling)
        }
        if (enabling) {
            notificationScheduler.scheduleAll(_uiState.value.routes)
        } else {
            notificationScheduler.cancelAll(_uiState.value.routes)
        }
    }

    fun toggleGpsTracking() {
        val enabling = !_uiState.value.gpsTrackingEnabled
        _uiState.value = _uiState.value.copy(gpsTrackingEnabled = enabling)
        viewModelScope.launch {
            userPreferencesRepository.setGpsTrackingEnabled(enabling)
        }
    }

    fun toggleDay(routeId: String, day: DayOfWeek) {
        val route = _uiState.value.routes.find { it.id == routeId } ?: return
        val oldDays = route.schedule.activeDays
        val newDays = if (oldDays.contains(day)) oldDays - day else oldDays + day
        if (newDays.isEmpty()) return

        viewModelScope.launch {
            try {
                routeRepository.updateRoute(
                    routeId = routeId,
                    activeDays = newDays,
                    timezone = route.schedule.timeZoneId
                )
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(errorMessage = e.message ?: "Failed to update route")
            }
        }
    }

    /**
     * Continuously collects the Room Flow. Any cache write (refresh, add, update, delete)
     * automatically propagates here and updates the UI without further intervention.
     */
    private fun collectPreferences() {
        viewModelScope.launch {
            userPreferencesRepository.userPreferences.collect { prefs ->
                _uiState.value = _uiState.value.copy(
                    notificationsEnabled = prefs.notificationsEnabled,
                    gpsTrackingEnabled   = prefs.gpsTrackingEnabled
                )
            }
        }
    }

    private fun collectRoutes() {
        viewModelScope.launch {
            routeRepository.observeRoutes().collect { routes ->
                _uiState.value = _uiState.value.copy(routes = routes, isInitialLoading = false)
                if (_uiState.value.notificationsEnabled) {
                    notificationScheduler.scheduleAll(routes)
                }
            }
        }
    }

    private fun refreshRoutes() {
        _uiState.value = _uiState.value.copy(isRefreshing = true, errorMessage = null)

        viewModelScope.launch {
            try {
                routeRepository.refreshRoutes()
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(errorMessage = e.message ?: "Failed to load routes")
            } finally {
                _uiState.value = _uiState.value.copy(isRefreshing = false)
            }
        }
    }
}
