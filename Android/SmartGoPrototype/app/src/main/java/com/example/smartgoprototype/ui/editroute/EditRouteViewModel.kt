package com.example.smartgoprototype.ui.editroute

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.smartgoprototype.domain.model.TravelMode
import com.example.smartgoprototype.domain.repository.RouteRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.time.DayOfWeek
import java.time.LocalTime
import java.time.ZoneId
import javax.inject.Inject

@HiltViewModel
class EditRouteViewModel @Inject constructor(
    private val routeRepository: RouteRepository,
    savedStateHandle: SavedStateHandle
) : ViewModel() {

    private val routeId: String = checkNotNull(savedStateHandle["routeId"])

    private val _uiState = MutableStateFlow(EditRouteUiState())
    val uiState: StateFlow<EditRouteUiState> = _uiState

    init { loadRoute() }

    private fun loadRoute() {
        viewModelScope.launch {
            runCatching { routeRepository.getRoutes() }
                .onSuccess { routes ->
                    val route = routes.find { it.id == routeId }
                    if (route != null) {
                        _uiState.value = EditRouteUiState(
                            routeId = route.id,
                            title = route.title,
                            originLabel = route.origin.label,
                            destinationLabel = route.destination.label,
                            travelMode = route.travelMode,
                            arriveBy = LocalTime.ofSecondOfDay(route.schedule.arriveByMinutes * 60L),
                            activeDays = route.schedule.activeDays,
                            isLoading = false
                        )
                    } else {
                        _uiState.value = _uiState.value.copy(
                            isLoading = false,
                            errorMessage = "Route not found"
                        )
                    }
                }
                .onFailure { e ->
                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        errorMessage = e.message ?: "Failed to load route"
                    )
                }
        }
    }

    fun onTitleChange(value: String) {
        _uiState.value = _uiState.value.copy(title = value, errorMessage = null)
    }

    fun onTravelModeSelected(mode: TravelMode) {
        _uiState.value = _uiState.value.copy(travelMode = mode, errorMessage = null)
    }

    fun onArriveByChange(hour: Int, minute: Int) {
        _uiState.value = _uiState.value.copy(
            arriveBy = _uiState.value.arriveBy.withHour(hour).withMinute(minute),
            errorMessage = null
        )
    }

    fun toggleDay(day: DayOfWeek) {
        val days = _uiState.value.activeDays
        _uiState.value = _uiState.value.copy(
            activeDays = if (days.contains(day)) days - day else days + day,
            errorMessage = null
        )
    }

    fun save(onSaved: () -> Unit) {
        val state = _uiState.value
        if (!state.canSave) return

        _uiState.value = state.copy(isSaving = true, errorMessage = null)

        viewModelScope.launch {
            runCatching {
                routeRepository.updateRoute(
                    routeId = state.routeId,
                    title = state.title.trim(),
                    travelMode = state.travelMode,
                    arriveByMinutes = state.arriveBy.hour * 60 + state.arriveBy.minute,
                    timezone = ZoneId.systemDefault().id,
                    activeDays = state.activeDays
                )
            }.onSuccess {
                _uiState.value = _uiState.value.copy(isSaving = false)
                onSaved()
            }.onFailure { e ->
                _uiState.value = _uiState.value.copy(
                    isSaving = false,
                    errorMessage = e.message ?: "Failed to save route"
                )
            }
        }
    }
}
