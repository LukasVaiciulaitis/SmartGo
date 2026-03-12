package com.example.smartgoprototype.ui.dashboard

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.smartgoprototype.domain.model.Route
import com.example.smartgoprototype.domain.repository.AuthRepository
import java.time.DayOfWeek
import com.example.smartgoprototype.domain.repository.RouteRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class DashboardViewModel @Inject constructor(
    private val routeRepository: RouteRepository,
    private val authRepository: AuthRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(DashboardUiState(isInitialLoading = true))
    val uiState: StateFlow<DashboardUiState> = _uiState

    // One-shot event: navigate to login after successful sign-out.
    private val _signOutEvent = Channel<Unit>(Channel.BUFFERED)
    val signOutEvent = _signOutEvent.receiveAsFlow()

    init { fetchRoutes(isRefresh = false) }

    fun refresh() {
        fetchRoutes(isRefresh = true)
    }

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
                routeRepository.deleteRoute(route.id)
                _uiState.value = _uiState.value.copy(
                    isDeletingRoute = false,
                    routes = _uiState.value.routes.filterNot { it.id == route.id }
                )
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(
                    isDeletingRoute = false,
                    errorMessage = e.message ?: "Failed to delete route"
                )
            }
        }
    }

    fun toggleDay(routeId: String, day: DayOfWeek) {
        val route = _uiState.value.routes.find { it.id == routeId } ?: return
        val oldDays = route.schedule.activeDays
        val newDays = if (oldDays.contains(day)) oldDays - day else oldDays + day
        if (newDays.isEmpty()) return // keep at least one active day

        // Optimistic update
        _uiState.value = _uiState.value.copy(
            routes = _uiState.value.routes.map { r ->
                if (r.id == routeId) r.copy(schedule = r.schedule.copy(activeDays = newDays)) else r
            }
        )

        viewModelScope.launch {
            try {
                routeRepository.updateRoute(
                    routeId = routeId,
                    activeDays = newDays,
                    timezone = route.schedule.timeZoneId
                )
            } catch (e: Exception) {
                // Revert on failure
                _uiState.value = _uiState.value.copy(
                    routes = _uiState.value.routes.map { r ->
                        if (r.id == routeId) r.copy(schedule = r.schedule.copy(activeDays = oldDays)) else r
                    },
                    errorMessage = e.message ?: "Failed to update route"
                )
            }
        }
    }

    private fun fetchRoutes(isRefresh: Boolean) {
        _uiState.value = _uiState.value.copy(
            isInitialLoading = !isRefresh,
            isRefreshing = isRefresh,
            errorMessage = null
        )

        viewModelScope.launch {
            try {
                val routes = routeRepository.getRoutes()
                _uiState.value = _uiState.value.copy(
                    isInitialLoading = false,
                    isRefreshing = false,
                    routes = routes,
                    errorMessage = null
                )
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(
                    isInitialLoading = false,
                    isRefreshing = false,
                    errorMessage = e.message ?: "Failed to load routes"
                )
            }
        }
    }
}
